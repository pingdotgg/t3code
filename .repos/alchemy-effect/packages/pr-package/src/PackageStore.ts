import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Bucket } from "./Bucket.ts";
import {
  emptyState,
  pullRequestBindings,
  releasePullRequests,
  tiePullRequest,
  withoutTags,
  type PackageState,
} from "./PackageState.ts";
import {
  formatPullRequest,
  isStillOpen,
  pullRequestState,
  type PullRequestRef,
} from "./PullRequest.ts";
import { TagIndex } from "./TagIndex.ts";
import { tarballId, tarballKey, tarballRef } from "./Tarball.ts";

export interface InitOptions {
  ttlMillis?: number;
  pullRequest?: PullRequestRef;
}

const EXPIRATION_EVENT = "expire";
const RETRY_DELAY_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Optional GitHub token for PR state lookups on TTL expiry. Bound as a
 * Worker secret when `GITHUB_TOKEN` is set at deploy time.
 */
export const GitHubToken = Config.Redacted("GITHUB_TOKEN").pipe(Config.option);

export default class PackageStore extends Cloudflare.DurableObject<PackageStore>()(
  "PackageStore",
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(yield* Bucket);
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(yield* TagIndex);
    const githubToken = yield* GitHubToken.pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

    return Effect.gen(function* () {
      const doState = yield* Cloudflare.DurableObjectState;

      const getState = Effect.gen(function* () {
        const stored = yield* doState.storage.get<PackageState>("state");
        return stored ?? emptyState;
      });

      const setState = (s: PackageState) => doState.storage.put("state", s);
      const scheduleExpiration = (expiresAt: number) =>
        Cloudflare.Workers.scheduleEvent(
          EXPIRATION_EVENT,
          new Date(expiresAt),
          null,
        ).pipe(Effect.provideService(Cloudflare.DurableObjectState, doState));
      const cancelExpiration = Cloudflare.Workers.cancelEvent(
        EXPIRATION_EVENT,
      ).pipe(Effect.provideService(Cloudflare.DurableObjectState, doState));
      const processExpirations = Cloudflare.Workers.processScheduledEvents.pipe(
        Effect.provideService(Cloudflare.DurableObjectState, doState),
      );

      /**
       * Drop `tagsToRemove` from KV (only where they still point here) and
       * from state. Deletes the blob when no tags remain; otherwise the
       * tarball keeps its remaining tags and its existing expiry.
       */
      const expireTags = (
        current: PackageState,
        tagsToRemove: Iterable<string>,
      ) =>
        Effect.gen(function* () {
          if (!current.packageName || !current.hash) return;
          const ref = tarballRef(current.packageName, current.hash);
          const id = tarballId(ref);
          const removing = new Set(tagsToRemove);
          for (const tag of removing) {
            const key = `tag:${current.packageName}:${tag}`;
            if ((yield* kv.get(key)) === id) {
              yield* kv.delete(key);
            }
          }

          const next = withoutTags(current, removing);
          if (next.tags.length === 0) {
            yield* r2.delete(tarballKey(ref)).pipe(Effect.orDie);
            yield* doState.storage.delete("state");
            yield* cancelExpiration;
            return;
          }
          yield* setState(next);
        });

      return {
        init: (
          packageName: string,
          hash: string,
          tags: string[],
          expiresAt: number,
          options?: InitOptions,
        ) =>
          Effect.gen(function* () {
            const current = yield* getState;
            const next: PackageState = {
              ...current,
              packageName,
              hash,
              tags: [...new Set([...current.tags, ...tags])],
              expiresAt,
            };
            const ttlMillis = options?.ttlMillis ?? current.ttlMillis;
            if (ttlMillis) next.ttlMillis = ttlMillis;
            if (options?.pullRequest) {
              next.pullRequests = tiePullRequest(
                current,
                options.pullRequest,
                tags,
                Date.now(),
              );
            }
            yield* setState(next);
            yield* scheduleExpiration(expiresAt);
          }),

        removeTag: (tag: string) =>
          Effect.gen(function* () {
            const current = yield* getState;
            const next = withoutTags(current, [tag]);
            yield* setState(next);
            return { orphaned: next.tags.length === 0 };
          }),

        /** Tear down one PR's tags; tags another tied PR still claims stay. */
        expirePullRequest: (number: number) =>
          Effect.gen(function* () {
            const current = yield* getState;
            const released = releasePullRequests(
              current,
              (binding) => binding.ref.number === number,
            );
            yield* expireTags(released.state, released.tags);
          }),

        recordDownload: (tag: string) =>
          Effect.gen(function* () {
            const current = yield* getState;
            // KV can still point here after a tag is removed. The Durable
            // Object owns tag membership, even while the tarball survives
            // under another tag.
            if (!current.tags.includes(tag)) return false;
            const downloads = { ...current.downloads };
            downloads[tag] = (downloads[tag] ?? 0) + 1;
            yield* setState({
              ...current,
              downloads,
              totalDownloads: current.totalDownloads + 1,
            });
            return true;
          }),

        getStats: () =>
          Effect.gen(function* () {
            const current = yield* getState;
            return {
              downloads: current.downloads,
              totalDownloads: current.totalDownloads,
            };
          }),

        getState: () => getState,

        alarm: () =>
          Effect.gen(function* () {
            const events = yield* processExpirations;
            if (!events.some((event) => event.id === EXPIRATION_EVENT)) return;

            yield* Effect.gen(function* () {
              const current = yield* getState;
              if (!current.packageName || !current.hash) return;
              const now = Date.now();

              const bindings = pullRequestBindings(current);
              if (bindings.length === 0) {
                yield* expireTags(current, current.tags);
                return;
              }

              const states = new Map(
                yield* Effect.forEach(bindings, (binding) =>
                  pullRequestState(binding.ref, githubToken).pipe(
                    Effect.map(
                      (state) =>
                        [formatPullRequest(binding.ref), state] as const,
                    ),
                  ),
                ),
              );
              const stateOf = (key: string) => states.get(key) ?? "unknown";

              // Refresh `verifiedAt` for PRs GitHub confirmed open, then
              // release every PR that is closed or unverified for too long.
              const refreshed: PackageState = {
                ...current,
                pullRequests: Object.fromEntries(
                  Object.entries(current.pullRequests ?? {}).map(
                    ([key, binding]) => [
                      key,
                      stateOf(key) === "open"
                        ? { ...binding, verifiedAt: now }
                        : binding,
                    ],
                  ),
                ),
              };
              const released = releasePullRequests(refreshed, (binding) => {
                const key = formatPullRequest(binding.ref);
                return !isStillOpen(
                  { state: stateOf(key), verifiedAt: binding.verifiedAt },
                  now,
                );
              });

              if (!released.state.pullRequests) {
                yield* expireTags(released.state, released.state.tags);
                return;
              }

              yield* expireTags(released.state, released.tags);
              const ttl =
                current.ttlMillis && current.ttlMillis > 0
                  ? current.ttlMillis
                  : WEEK_MS;
              const expiresAt = now + ttl;
              const latest = yield* getState;
              if (!latest.packageName) return;
              yield* setState({ ...latest, expiresAt });
              yield* scheduleExpiration(expiresAt);
            }).pipe(
              Effect.catchCause((cause) =>
                scheduleExpiration(Date.now() + RETRY_DELAY_MS).pipe(
                  Effect.andThen(Effect.failCause(cause)),
                ),
              ),
            );
          }),
      };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.KV.ReadWriteNamespaceBinding,
      ),
    ),
  ),
) {}
