import { expect, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { PullRequestCheck } from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { makeChecksRevalidator } from "./gitHubConditionalChecks.ts";

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
      const revalidate = yield* makeChecksRevalidator.pipe(
        Effect.provide(
          Layer.mock(GitHubCli.GitHubCli)({
            execute: ({ args }) =>
              Effect.sync(() => {
                const endpoint = args[1]!;
                requests.push(endpoint);
                const head = endpoint.endsWith("/pulls/1");
                const modified =
                  !args.includes("-H") || (endpoint.includes(changed) && changed !== "");
                const next = endpoint.includes("check-runs") && endpoint.endsWith("page=1");
                return {
                  exitCode: ChildProcessSpawner.ExitCode(modified ? 0 : 1),
                  stdout: modified
                    ? `HTTP/2.0 200 OK\r\nEtag: "${sha}-${changed}"\r\n${next ? 'Link: <https://api.github.com/next>; rel="next"\r\n' : ""}\r\n${head ? encodeJson({ head: { sha }, base: { repo: { id: 1 } }, headRepositoryId: 2 }) : ""}`
                    : "HTTP/2.0 304 Not Modified\r\n\r\n",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
        ),
      );
      const read = Effect.sync(() => {
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
          Effect.provideService(GitHubCli.PinnedGitHubCredential, identity),
        );
      yield* poll();
      expect(reads).toBe(1);
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
      expect((yield* poll()).headSha).toBe(sha);
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
        Layer.mock(GitHubCli.GitHubCli)({
          execute: ({ args }) =>
            unavailable
              ? Effect.fail(
                  new GitHubCli.GitHubCliCommandError({
                    command: "gh",
                    cwd: "/repo",
                    cause: undefined,
                    httpStatus: 502,
                  }),
                )
              : Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout:
                    args.includes("-H") && etags
                      ? "HTTP/2.0 304 Not Modified\n\n"
                      : `HTTP/2.0 200 OK\n${etags ? 'Etag: "one"\n' : ""}\n${args[1]!.endsWith("/pulls/1") ? encodeJson({ head: { sha }, base: { repo: { id: 1 } }, headRepositoryId: 1 }) : ""}`,
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }),
        }),
      ),
    );
    const read = Effect.suspend(() => {
      reads++;
      return fail
        ? Effect.fail(
            new GitHubCli.GitHubCliCommandError({ command: "gh", cwd: "/repo", cause: undefined }),
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
        Effect.provideService(GitHubCli.PinnedGitHubCredential, credential),
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
    unavailable = true;
    yield* poll();
    expect(reads).toBe(5);
    unavailable = false;
    yield* poll();
    yield* poll();
    expect(reads).toBe(6);
    etags = false;
    yield* poll();
    yield* poll();
    expect(reads).toBe(8);
  }),
);

it.effect("falls back when REST checks are unavailable without retrying unsupported probes", () =>
  Effect.gen(function* () {
    let probes = 0;
    let reads = 0;
    const revalidate = yield* makeChecksRevalidator.pipe(
      Effect.provide(
        Layer.mock(GitHubCli.GitHubCli)({
          execute: () => {
            probes++;
            return Effect.fail(
              new GitHubCli.GitHubCliCommandError({
                command: "gh",
                cwd: "/repo",
                cause: undefined,
                httpStatus: 404,
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
        Effect.provideService(GitHubCli.PinnedGitHubCredential, credential),
      );
    expect(probes).toBe(1);
    expect(reads).toBe(2);
  }),
);
