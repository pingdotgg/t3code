import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsPullRequestCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestCli";
import * as AzureDevOpsPullRequestProvider from "@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestProvider";

import { evaluatePullRequestWatch, pullRequestWatchMessage } from "./pullRequestWatch.ts";

it.effect("reports Azure build failures and completion, including reruns without a head SHA", () =>
  Effect.gen(function* () {
    let status = "queued";
    const provider = yield* AzureDevOpsPullRequestProvider.make.pipe(
      Effect.provide(
        AzureDevOpsPullRequestCli.layer.pipe(
          Layer.provide(
            Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
              execute: ({ args }) => {
                const response = args.includes("show")
                  ? {
                      pullRequestId: 42,
                      title: "Build validation",
                      status: "active",
                      sourceRefName: "refs/heads/fix/build",
                      targetRefName: "refs/heads/main",
                      creationDate: "2026-10-01T00:00:00Z",
                      repository: { name: "web", project: { name: "platform" } },
                      url: "https://dev.azure.com/example/platform/_apis/git/repositories/web/pullRequests/42",
                    }
                  : args.includes("policy")
                    ? [
                        {
                          status,
                          configuration: {
                            id: 1,
                            isEnabled: true,
                            isBlocking: true,
                            type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
                            settings: { displayName: "Tests" },
                          },
                        },
                        {
                          status: "running",
                          configuration: {
                            id: 2,
                            isEnabled: true,
                            isBlocking: false,
                            type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
                            settings: { displayName: "Advisory" },
                          },
                        },
                      ]
                    : { value: [] };
                return Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: JSON.stringify(response),
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                });
              },
            }),
          ),
        ),
      ),
    );
    const read = provider
      .getChangeRequest({
        cwd: "/workspace",
        host: "dev.azure.com",
        repository: "example/platform/web",
        number: 42,
      })
      .pipe(Effect.map((detail) => ({ ...detail, headSha: detail.headSha ?? undefined })));
    const initial = yield* read;
    assert.isTrue(initial.checks.some((check) => check.status === "pending"));
    const waiting = evaluatePullRequestWatch(
      {
        startedAt: "2026-10-01T00:00:00Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-10-01T00:00:00Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
      initial,
      [],
    );
    assert.deepEqual(waiting.changes, []);

    status = "rejected";
    const failedDetail = yield* read;
    const failed = evaluatePullRequestWatch(waiting.next, failedDetail, []);
    assert.deepEqual(failed.changes, [
      { kind: "checks-failed", failed: failedDetail.checks.filter((check) => check.required) },
    ]);
    const messageInput = {
      number: 42,
      url: failedDetail.url,
      baseBranch: "main",
      headSha: null,
    };
    assert.equal(
      pullRequestWatchMessage({ ...messageInput, report: failed }).notification.outcome,
      "failed",
    );
    assert.deepEqual(evaluatePullRequestWatch(failed.next, yield* read, []).changes, []);

    status = "running";
    const rerun = evaluatePullRequestWatch(failed.next, yield* read, []);
    assert.deepEqual(rerun.changes, []);
    status = "rejected";
    const failedAgain = evaluatePullRequestWatch(rerun.next, yield* read, []);
    assert.equal(failedAgain.changes[0]?.kind, "checks-failed");

    status = "approved";
    const passed = evaluatePullRequestWatch(failedAgain.next, yield* read, []);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.equal(
      pullRequestWatchMessage({ ...messageInput, report: passed }).notification.outcome,
      "completed",
    );
    assert.deepEqual(evaluatePullRequestWatch(passed.next, yield* read, []).changes, []);

    status = "queued";
    const rebuilding = evaluatePullRequestWatch(passed.next, yield* read, []);
    assert.deepEqual(rebuilding.changes, []);
    status = "approved";
    assert.deepEqual(evaluatePullRequestWatch(rebuilding.next, yield* read, []).changes, [
      { kind: "checks-passed", count: 1, required: true },
    ]);
  }),
);
