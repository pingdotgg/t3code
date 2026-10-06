import * as Clock from "effect/Clock";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { PositiveInt, type PullRequestChecks } from "@t3tools/contracts";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import type { GitHubPullRequestDetail } from "./gitHubPullRequestJson.ts";
import type { GitHubPullRequestCliError } from "./GitHubPullRequestCli.ts";
import type { ProviderRepositoryRef } from "./PullRequestProvider.ts";

const HeadSchema = Schema.Struct({
  head: Schema.Struct({
    sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
    // Null once the fork a pull request came from has been deleted.
    repo: Schema.NullOr(Schema.Struct({ id: PositiveInt })),
  }),
  base: Schema.Struct({ repo: Schema.Struct({ id: PositiveInt }) }),
});
const decodeHead = Schema.decodeUnknownEffect(Schema.fromJsonString(HeadSchema));

const WorkflowRunSchema = Schema.Struct({
  id: Schema.Int,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  head_branch: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeWorkflowRuns = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ workflow_runs: Schema.Array(WorkflowRunSchema) })),
);

export type KnownWorkflowRun = typeof WorkflowRunSchema.Type;

/**
 * Every `pull_request` workflow run of one head, as the revalidator just confirmed them against
 * GitHub. A read running under it filters these rather than asking for the runs again.
 */
export const KnownWorkflowRuns = Context.Reference<{
  readonly headSha: string;
  readonly runs: ReadonlyArray<KnownWorkflowRun>;
} | null>("t3/pullRequest/KnownWorkflowRuns", { defaultValue: () => null });

type Validator = { etag: string | undefined; next: boolean; body: string };

/** A host that answers these with one of them has no conditional REST for it at all. */
const UNSUPPORTED_STATUSES = new Set([404, 405, 501]);

export const makeChecksRevalidator = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const entries = yield* Cache.makeWith(
    (_key: string) =>
      Effect.sync(() => ({
        gate: Semaphore.makeUnsafe(1),
        validators: new Map<string, Validator>(),
        head: null as typeof HeadSchema.Type | null,
        value: null as PullRequestChecks | null,
        readAt: 0,
        supported: true,
      })),
    { capacity: 128, timeToLive: () => "30 minutes" },
  );
  return (
    input: ProviderRepositoryRef & { readonly number: number },
    read: Effect.Effect<
      Pick<GitHubPullRequestDetail, "state" | "checks" | "headSha"> & {
        workflowApprovalsRequired?: number;
      },
      GitHubPullRequestCliError
    >,
  ) =>
    Effect.gen(function* () {
      const credential = yield* GitHubApi.PinnedGitHubCredential;
      if (credential === null) return yield* read;
      const key = `${credential.credentialFingerprint}\0${input.host}\0${input.repository}\0${input.number}`;
      const entry = yield* Cache.get(entries, key);
      return yield* entry.gate.withPermit(
        Effect.gen(function* () {
          if (!entry.supported) return yield* read;
          const fail = (status: number) =>
            new GitHubApi.GitHubApiResponseError({
              host: input.host,
              operation: "revalidateChecks",
              status,
            });
          /** Whether the endpoint has a next page, or null where the host cannot say. */
          const get = (endpoint: string, head = false) =>
            Effect.gen(function* () {
              const previous = entry.validators.get(endpoint);
              const response = yield* api
                .rest({
                  host: input.host,
                  operation: "revalidateChecks",
                  path: endpoint,
                  ...(previous?.etag ? { ifNoneMatch: previous.etag } : {}),
                })
                .pipe(
                  Effect.catchTags({
                    GitHubApiNotFoundError: () =>
                      Effect.sync(() => {
                        entry.supported = false;
                        return null;
                      }),
                    GitHubApiResponseError: (error) =>
                      Effect.sync(() => {
                        entry.supported = !UNSUPPORTED_STATUSES.has(error.status);
                        return null;
                      }),
                  }),
                );
              if (response === null) {
                entry.value = null;
                return null;
              }
              if (response.status === 304 && previous) return previous.next;
              if (response.status !== 200 || response.truncated) {
                return yield* fail(response.status);
              }
              entry.value = null;
              if (head) {
                const decoded = yield* decodeHead(response.body).pipe(
                  Effect.mapError(() => fail(response.status)),
                );
                if (entry.head?.head.sha !== decoded.head.sha) entry.validators.clear();
                entry.head = decoded;
              }
              const validator = {
                etag: response.headers["etag"]?.trim(),
                next: /rel="next"/.test(response.headers["link"] ?? ""),
                body: response.body,
              };
              entry.validators.set(endpoint, validator);
              return validator.next;
            });
          const root = `repos/${input.repository}`;
          if ((yield* get(`${root}/pulls/${input.number}`, true)) === null) return yield* read;
          const head = entry.head;
          if (head === null) return yield* fail(200);
          const runsEndpoint =
            head.head.repo?.id !== head.base.repo.id
              ? `${root}/actions/runs?head_sha=${head.head.sha}&event=pull_request`
              : null;
          const endpoints = [
            `${root}/commits/${head.head.sha}/check-runs?filter=all`,
            `${root}/commits/${head.head.sha}/status`,
            ...(runsEndpoint === null ? [] : [runsEndpoint]),
          ];
          const runPages: Array<string> = [];
          for (const endpoint of endpoints) {
            for (let page = 1; ; page++) {
              if (page > 100) return yield* fail(200);
              const paged = `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
              const next = yield* get(paged);
              if (next === null) return yield* read;
              if (endpoint === runsEndpoint) runPages.push(paged);
              if (!next) break;
            }
          }
          const now = yield* Clock.currentTimeMillis;
          if (entry.value !== null && now - entry.readAt < 5 * 60_000) return entry.value;
          // Every page of the head's runs was just confirmed current, so the read filters them
          // rather than listing the runs a second time.
          const pages = runPages.map((endpoint) =>
            decodeWorkflowRuns(entry.validators.get(endpoint)?.body ?? ""),
          );
          const known =
            runsEndpoint !== null && pages.every(Option.isSome)
              ? {
                  headSha: head.head.sha,
                  runs: pages.flatMap((page) =>
                    Option.isSome(page) ? page.value.workflow_runs : [],
                  ),
                }
              : null;
          const fresh = yield* read.pipe(Effect.provideService(KnownWorkflowRuns, known));
          const value = {
            state: fresh.state,
            checks: fresh.checks,
          };
          entry.value =
            fresh.workflowApprovalsRequired !== undefined && fresh.headSha === head.head.sha
              ? value
              : null;
          entry.readAt = now;
          return value;
        }),
      );
    });
});
