import { expect, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import type { PullRequestCheck } from "@t3tools/contracts";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import { KnownWorkflowRuns, makeChecksRevalidator } from "./gitHubConditionalChecks.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const reference = { cwd: "/repo", repository: "acme/web", host: "github.com", number: 1 };
const credential = {
  host: "github.com",
  token: Redacted.make("token"),
  credentialFingerprint: "one",
};

it.effect(
  "reuses unchanged checks and catches reruns, later pages, fork approvals, pushes and account changes",
  () =>
    Effect.gen(function* () {
      let sha = "a".repeat(40);
      let changed = "";
      let reads = 0;
      const requests: string[] = [];
      const known: Array<unknown> = [];
      const revalidate = yield* makeChecksRevalidator.pipe(
        Effect.provide(
          Layer.mock(GitHubApi.GitHubApi)({
            rest: ({ path, ifNoneMatch }) =>
              Effect.sync(() => {
                requests.push(path);
                const head = path.endsWith("/pulls/1");
                const modified =
                  ifNoneMatch === undefined || (path.includes(changed) && changed !== "");
                const next = path.includes("check-runs") && path.endsWith("page=1");
                const runs = path.includes("/actions/runs");
                return {
                  status: modified ? 200 : 304,
                  headers: modified
                    ? {
                        etag: `"${sha}-${changed}"`,
                        ...(next ? { link: '<https://api.github.com/next>; rel="next"' } : {}),
                      }
                    : {},
                  body: !modified
                    ? ""
                    : head
                      ? encodeJson({ head: { sha, repo: { id: 2 } }, base: { repo: { id: 1 } } })
                      : runs
                        ? encodeJson({
                            workflow_runs: [
                              { id: 9, status: "completed", conclusion: "action_required" },
                            ],
                          })
                        : "{}",
                  truncated: false,
                  invalidUtf8: false,
                };
              }),
          }),
        ),
      );
      const read = Effect.gen(function* () {
        known.push(yield* KnownWorkflowRuns);
        reads++;
        return {
          state: "open" as const,
          checks: [
            { name: "build", status: "success", description: null, url: null },
          ] satisfies PullRequestCheck[],
          headSha: sha,
          workflowApprovalsRequired: 0,
        };
      });
      const poll = (identity = credential) =>
        revalidate(reference, read).pipe(
          Effect.provideService(GitHubApi.PinnedGitHubCredential, identity),
        );
      yield* poll();
      expect(reads).toBe(1);
      // The fork's runs were just confirmed, so the read is handed them instead of listing them.
      expect(known[0]).toEqual({
        headSha: sha,
        runs: [{ id: 9, status: "completed", conclusion: "action_required" }],
      });
      requests.length = 0;
      yield* poll();
      expect(reads).toBe(1);
      expect(requests).toHaveLength(5);
      for (const endpoint of [
        "check-runs?filter=all&per_page=100&page=2",
        "/status",
        "/actions/runs",
        "/pulls/1",
      ]) {
        changed = endpoint;
        yield* poll();
        changed = "";
        yield* poll();
      }
      expect(reads).toBe(5);
      sha = "b".repeat(40);
      changed = "/pulls/1";
      requests.length = 0;
      yield* poll();
      expect(reads).toBe(6);
      expect(
        requests
          .filter((endpoint) => endpoint.includes("/commits/"))
          .every((endpoint) => endpoint.includes(sha)),
      ).toBe(true);
      changed = "";
      yield* poll({ ...credential, credentialFingerprint: "two" });
      expect(reads).toBe(7);
      yield* TestClock.adjust("5 minutes");
      yield* poll();
      expect(reads).toBe(8);
    }),
);

it.effect("does not retain failed or incomplete reads, and supports hosts without ETags", () =>
  Effect.gen(function* () {
    const sha = "a".repeat(40);
    let etags = true;
    let unavailable = false;
    let fail = true;
    let complete = true;
    let reads = 0;
    const revalidate = yield* makeChecksRevalidator.pipe(
      Effect.provide(
        Layer.mock(GitHubApi.GitHubApi)({
          rest: ({ path, ifNoneMatch }) =>
            unavailable
              ? Effect.fail(
                  new GitHubApi.GitHubApiResponseError({
                    host: "github.com",
                    operation: "revalidateChecks",
                    status: 502,
                  }),
                )
              : Effect.succeed(
                  ifNoneMatch !== undefined && etags
                    ? { status: 304, headers: {}, body: "", truncated: false, invalidUtf8: false }
                    : {
                        status: 200,
                        headers: etags ? { etag: '"one"' } : {},
                        body: path.endsWith("/pulls/1")
                          ? encodeJson({
                              head: { sha, repo: { id: 1 } },
                              base: { repo: { id: 1 } },
                            })
                          : "{}",
                        truncated: false,
                        invalidUtf8: false,
                      },
                ),
        }),
      ),
    );
    const read = Effect.suspend(() => {
      reads++;
      return fail
        ? Effect.fail(
            new GitHubApi.GitHubApiResponseError({
              host: "github.com",
              operation: "read",
              status: 500,
            }),
          )
        : Effect.succeed({
            state: "open" as const,
            checks: [],
            headSha: sha,
            ...(complete ? { workflowApprovalsRequired: 0 } : {}),
          });
    });
    const poll = () =>
      revalidate(reference, read).pipe(
        Effect.provideService(GitHubApi.PinnedGitHubCredential, credential),
      );
    yield* poll().pipe(Effect.flip);
    fail = false;
    complete = false;
    yield* poll();
    yield* poll();
    expect(reads).toBe(3);
    complete = true;
    yield* poll();
    yield* poll();
    expect(reads).toBe(4);
    yield* TestClock.adjust("5 minutes");
    complete = false;
    yield* poll();
    yield* poll();
    expect(reads).toBe(6);
    complete = true;
    unavailable = true;
    yield* poll();
    expect(reads).toBe(7);
    unavailable = false;
    yield* poll();
    yield* poll();
    expect(reads).toBe(8);
    etags = false;
    yield* poll();
    yield* poll();
    expect(reads).toBe(10);
  }),
);

it.effect("falls back when REST checks are unavailable without retrying unsupported probes", () =>
  Effect.gen(function* () {
    let probes = 0;
    let reads = 0;
    const revalidate = yield* makeChecksRevalidator.pipe(
      Effect.provide(
        Layer.mock(GitHubApi.GitHubApi)({
          rest: () => {
            probes++;
            return Effect.fail(
              new GitHubApi.GitHubApiNotFoundError({
                host: "github.com",
                operation: "revalidateChecks",
              }),
            );
          },
        }),
      ),
    );
    const read = Effect.sync(() => {
      reads++;
      return { state: "open" as const, checks: [] };
    });
    for (let tick = 0; tick < 2; tick++)
      yield* revalidate(reference, read).pipe(
        Effect.provideService(GitHubApi.PinnedGitHubCredential, credential),
      );
    expect(probes).toBe(1);
    expect(reads).toBe(2);
  }),
);
