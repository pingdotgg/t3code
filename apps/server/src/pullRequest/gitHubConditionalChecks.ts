import * as Clock from "effect/Clock";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { PositiveInt, type PullRequestChecks } from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import type { GitHubPullRequestDetail } from "./gitHubPullRequestJson.ts";
import type { GitHubPullRequestCliError } from "./GitHubPullRequestCli.ts";
import type { ProviderRepositoryRef } from "./PullRequestProvider.ts";

const decodeHeadSchema = Schema.Struct({
  head: Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)) }),
  base: Schema.Struct({ repo: Schema.Struct({ id: PositiveInt }) }),
  headRepositoryId: Schema.NullOr(PositiveInt),
});
const decodeHead = Schema.decodeUnknownEffect(Schema.fromJsonString(decodeHeadSchema));

type Validator = { etag: string | undefined; next: boolean };

export const makeChecksRevalidator = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const entries = yield* Cache.makeWith(
    (_key: string) =>
      Effect.sync(() => ({
        gate: Semaphore.makeUnsafe(1),
        validators: new Map<string, Validator>(),
        head: null as Schema.Schema.Type<typeof decodeHeadSchema> | null,
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
      const credential = yield* GitHubCli.PinnedGitHubCredential;
      if (credential === null) return yield* read;
      const key = `${credential.credentialFingerprint}\0${input.host}\0${input.repository}\0${input.number}`;
      const entry = yield* Cache.get(entries, key);
      return yield* entry.gate.withPermit(
        Effect.gen(function* () {
          if (!entry.supported) return yield* read;
          const fail = () =>
            new GitHubCli.GitHubCliCommandError({
              command: "gh",
              cwd: input.cwd,
              cause: new Error("GitHub returned an invalid conditional checks response."),
            });
          const get = (endpoint: string, head = false) =>
            Effect.gen(function* () {
              const previous = entry.validators.get(endpoint);
              const result = yield* github
                .execute({
                  cwd: input.cwd,
                  args: [
                    "api",
                    endpoint,
                    "--hostname",
                    input.host,
                    "--include",
                    ...(head
                      ? [
                          "--jq",
                          "{head:{sha:.head.sha},base:{repo:{id:.base.repo.id}},headRepositoryId:.head.repo.id}",
                        ]
                      : ["--silent"]),
                    ...(previous?.etag ? ["-H", `If-None-Match: ${previous.etag}`] : []),
                  ],
                  acceptNotModified: true,
                })
                .pipe(
                  Effect.catchTags({
                    GitHubCliCommandError: (error) =>
                      Effect.sync(() => {
                        entry.supported = ![404, 405, 501].includes(error.httpStatus ?? 0);
                        return null;
                      }),
                  }),
                );
              if (result === null) {
                entry.value = null;
                return null;
              }
              if (result.stdoutTruncated || result.stdoutInvalidUtf8) return yield* fail();
              const split = result.stdout.search(/\r?\n\r?\n/);
              const headers = split < 0 ? result.stdout : result.stdout.slice(0, split);
              const status = /^HTTP\/\S+ (\d+)/.exec(headers)?.[1];
              if (status === "304" && previous) return previous.next;
              if (status !== "200") return yield* fail();
              entry.value = null;
              if (head) {
                const decoded = yield* decodeHead(result.stdout.slice(split).trim()).pipe(
                  Effect.mapError(fail),
                );
                if (entry.head?.head.sha !== decoded.head.sha) entry.validators.clear();
                entry.head = decoded;
              }
              const validator = {
                etag: /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim(),
                next: /^link:.*rel="next"/im.test(headers),
              };
              entry.validators.set(endpoint, validator);
              return validator.next;
            });
          const root = `repos/${input.repository}`;
          if ((yield* get(`${root}/pulls/${input.number}`, true)) === null) return yield* read;
          const head = entry.head;
          if (head === null) return yield* fail();
          const endpoints = [
            `${root}/commits/${head.head.sha}/check-runs?filter=all`,
            `${root}/commits/${head.head.sha}/status`,
            ...(head.headRepositoryId !== head.base.repo.id
              ? [`${root}/actions/runs?head_sha=${head.head.sha}&event=pull_request`]
              : []),
          ];
          for (const endpoint of endpoints) {
            for (let page = 1; ; page++) {
              if (page > 100) return yield* fail();
              const next = yield* get(
                `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
              );
              if (next === null) return yield* read;
              if (!next) break;
            }
          }
          const now = yield* Clock.currentTimeMillis;
          if (entry.value !== null && now - entry.readAt < 5 * 60_000) return entry.value;
          const fresh = yield* read;
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
