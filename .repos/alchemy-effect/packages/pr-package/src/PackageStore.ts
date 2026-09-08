import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Bucket } from "./Bucket.ts";
import { TagIndex } from "./TagIndex.ts";
import { tarballId, tarballKey, tarballRef } from "./Tarball.ts";

interface PackageState {
  packageName: string;
  hash: string;
  tags: string[];
  expiresAt: number;
  downloads: Record<string, number>;
  totalDownloads: number;
}

const emptyState: PackageState = {
  packageName: "",
  hash: "",
  tags: [],
  expiresAt: 0,
  downloads: {},
  totalDownloads: 0,
};

const EXPIRATION_EVENT = "expire";
const RETRY_DELAY_MS = 60_000;

export default class PackageStore extends Cloudflare.DurableObject<PackageStore>()(
  "PackageStore",
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(yield* Bucket);
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(yield* TagIndex);

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
      const processExpirations = Cloudflare.Workers.processScheduledEvents.pipe(
        Effect.provideService(Cloudflare.DurableObjectState, doState),
      );

      return {
        init: (
          packageName: string,
          hash: string,
          tags: string[],
          expiresAt: number,
        ) =>
          Effect.gen(function* () {
            const current = yield* getState;
            const merged = new Set([...current.tags, ...tags]);
            const newState: PackageState = {
              packageName,
              hash,
              tags: [...merged],
              expiresAt,
              downloads: current.downloads,
              totalDownloads: current.totalDownloads,
            };
            yield* setState(newState);
            yield* scheduleExpiration(expiresAt);
          }),

        removeTag: (tag: string) =>
          Effect.gen(function* () {
            const current = yield* getState;
            const tags = current.tags.filter((t) => t !== tag);
            yield* setState({ ...current, tags });
            return { orphaned: tags.length === 0 };
          }),

        recordDownload: (tag: string) =>
          Effect.gen(function* () {
            const current = yield* getState;
            const downloads = { ...current.downloads };
            downloads[tag] = (downloads[tag] ?? 0) + 1;
            yield* setState({
              ...current,
              downloads,
              totalDownloads: current.totalDownloads + 1,
            });
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

              const ref = tarballRef(current.packageName, current.hash);
              const id = tarballId(ref);
              for (const tag of current.tags) {
                const key = `tag:${current.packageName}:${tag}`;
                if ((yield* kv.get(key)) === id) {
                  yield* kv.delete(key);
                }
              }

              yield* r2.delete(tarballKey(ref)).pipe(Effect.orDie);
              yield* doState.storage.delete("state");
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
