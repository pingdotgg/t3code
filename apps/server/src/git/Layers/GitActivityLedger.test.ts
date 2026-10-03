import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GitActivityLogError,
  GitPullRequestAssociation,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { withLogContext } from "../../observability/LogContext.ts";
import { GitActivityLedgerLive } from "../../persistence/Layers/GitActivityLedger.ts";
import { ProjectionThreadPullRequestRepositoryLive } from "../../persistence/Layers/ProjectionThreadPullRequests.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadPullRequestRepository } from "../../persistence/Services/ProjectionThreadPullRequests.ts";
import { GitActivityLedger } from "../../persistence/Services/GitActivityLedger.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import { makeGitCore } from "./GitCore.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-activity-ledger-test-",
});
const sqliteLayer = SqlitePersistenceMemory;

const testLayer = it.layer(
  GitActivityLedgerLive.pipe(
    Layer.provideMerge(ProjectionThreadPullRequestRepositoryLive),
    Layer.provideMerge(sqliteLayer),
  ),
);

const makePullRequest = (number: number, repository: string) =>
  ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    baseBranch: "main",
    headBranch: `feature-${number}`,
    state: "open",
  }) satisfies typeof GitPullRequestAssociation.Type;

testLayer("Git activity ledger through GitCore.execute", (it) => {
  it.effect("persists mutations, scopes by thread and PR, and redacts Git credentials", () =>
    Effect.gen(function* () {
      const core = yield* makeGitCore({
        executeOverride: () =>
          Effect.succeed({
            code: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }).pipe(Effect.provide(Layer.provideMerge(configLayer, NodeServices.layer)));
      const ledger = yield* GitActivityLedger;
      const pullRequests = yield* ProjectionThreadPullRequestRepository;
      const sql = yield* SqlClient.SqlClient;
      const ledgerTable = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'git_activity_log'
      `;
      assert.equal(ledgerTable.length, 1);
      const threadId = ThreadId.make("git-activity-thread-617");
      const otherThreadId = ThreadId.make("git-activity-thread-618");
      const fallbackThreadId = ThreadId.make("git-activity-thread-fallback");
      const pullRequest = makePullRequest(617, "owner/repo-a");
      const otherPullRequest = makePullRequest(618, "owner/repo-b");

      yield* pullRequests.upsert({
        threadId,
        pullRequest,
        source: "created",
        linkedAt: "2026-10-01T00:00:00.000Z",
      });
      yield* pullRequests.upsert({
        threadId: otherThreadId,
        pullRequest: otherPullRequest,
        source: "created",
        linkedAt: "2026-10-01T00:00:00.000Z",
      });

      const execute = (
        target: GitCoreShape,
        activeThreadId: ThreadId,
        operation: string,
        args: string[],
      ) =>
        withLogContext({ threadId: activeThreadId })(
          target.execute({
            operation,
            cwd: `/worktrees/${activeThreadId}`,
            args,
          }),
        );

      yield* execute(core, threadId, "git.status", ["status", "--short"]);
      yield* execute(core, threadId, "git.rev-parse", ["rev-parse", "--show-toplevel"]);
      yield* execute(core, threadId, "git.commit", ["commit", "-m", "update"]);
      yield* execute(core, threadId, "git.push", [
        "-c",
        "http.extraheader=Authorization: Basic c2VjcmV0",
        "push",
        "https://live-token@github.com/owner/repo-a.git",
      ]);
      yield* execute(core, otherThreadId, "git.commit", ["commit", "-m", "other repo"]);

      const fallbackCwd = "/worktrees/git-activity-fallback";
      const readModel = {
        threads: [
          {
            id: fallbackThreadId,
            deletedAt: null,
            archivedAt: null,
            worktreePath: fallbackCwd,
          },
        ],
      } as unknown as OrchestrationReadModel;
      yield* withLogContext({})(
        core.execute({
          operation: "git.commit",
          cwd: fallbackCwd,
          args: ["commit", "-m", "owner fallback"],
        }),
      ).pipe(
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed(readModel),
        } as unknown as OrchestrationEngineService["Service"]),
      );

      const defaultRows = yield* ledger.list({ all: false, limit: 100 });
      const allRows = yield* ledger.list({ all: true, limit: 100 });
      const threadRows = yield* ledger.list({ all: true, limit: 100, threadId });
      const pullRequestRows = yield* ledger.list({ all: true, limit: 100, pullRequestNumber: 617 });

      assert.equal(defaultRows.length, 4);
      assert.equal(allRows.length, 6);
      assert.equal(threadRows.length, 4);
      assert.equal(pullRequestRows.length, 4);
      assert.isTrue(threadRows.every((row) => row.threadId === threadId));
      assert.isTrue(pullRequestRows.every((row) => row.pullRequests[0]?.url === pullRequest.url));
      assert.isTrue(threadRows.some((row) => row.operation === "git.status"));
      assert.isTrue(
        allRows.some((row) => row.cwd === fallbackCwd && row.threadId === fallbackThreadId),
      );

      const push = allRows.find((row) => row.operation === "git.push");
      assert.exists(push);
      const serializedPush = JSON.stringify(push.args);
      assert.notInclude(serializedPush, "live-token");
      assert.notInclude(serializedPush, "c2VjcmV0");
      assert.include(serializedPush, "[REDACTED]");
      assert.isNumber(push.durationMs);
      assert.equal(push.exitCode, 0);
      assert.equal(push.cwd, `/worktrees/${threadId}`);

      const failingLedger: GitActivityLedger["Service"] = {
        record: () => Effect.fail(new GitActivityLogError({ message: "Ledger unavailable." })),
        list: () => Effect.fail(new GitActivityLogError({ message: "Ledger unavailable." })),
      };
      const unaffectedCommand = yield* core
        .execute({
          operation: "git.commit",
          cwd: "/worktrees/unavailable-ledger",
          args: ["commit"],
        })
        .pipe(Effect.provideService(GitActivityLedger, failingLedger));
      assert.equal(unaffectedCommand.code, 0);
    }),
  );
});
