import { assert, it } from "@effect/vitest";
import {
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitButlerProjectRegistry from "./GitButlerProjectRegistry.ts";
import * as GitButlerWorkspace from "./GitButlerWorkspace.ts";

const workspaceRoot = "/workspace/project";

const processOutput = (
  stdout: string,
  exitCode: ChildProcessSpawner.ExitCode = ChildProcessSpawner.ExitCode(0),
): VcsProcess.VcsProcessOutput => ({
  exitCode,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const readyStatus = JSON.stringify({
  uncommittedChanges: [{ cliId: "u1", filePath: "src/unassigned.ts", changeType: "modified" }],
  conflictedFiles: ["src/conflict.ts"],
  stacks: [
    {
      cliId: "s1",
      assignedChanges: [{ cliId: "a1", filePath: "src/conflict.ts", changeType: "conflicted" }],
      branches: [
        {
          cliId: "b1",
          name: "feature/stacked-child",
          commits: [
            {
              cliId: "c1",
              changeId: "change-1",
              commitId: "abc123",
              createdAt: "2026-09-08T12:00:00Z",
              message: "fix: resolve conflict",
              authorName: "Alice",
              authorEmail: "alice@example.com",
              conflicted: true,
              reviewId: "review-42",
              changes: [{ cliId: "c1:f1", filePath: "src/conflict.ts", changeType: "modified" }],
            },
          ],
          upstreamCommits: [],
          branchStatus: "completelyUnpushed",
          reviewId: "(#42)",
          ci: {
            pendingCheckTitles: [],
            passingCheckTitles: ["test"],
            failingCheckTitles: [],
            status: "complete",
            conclusion: "success",
          },
        },
      ],
    },
  ],
  mergeBase: {
    cliId: "",
    commitId: "base123",
    createdAt: "2026-09-08T10:00:00Z",
    message: "base",
    authorName: "Maintainer",
    authorEmail: "maintainer@example.com",
    conflicted: null,
    reviewId: null,
    changes: null,
  },
  upstreamState: {
    behind: 2,
    latestCommit: null,
    lastFetched: "2026-09-08T13:00:00Z",
  },
});

function testLayer(input: {
  readonly registration?: GitButlerProjectRegistry.GitButlerRegistrationStatus;
  readonly statusOutput?: string;
  readonly statusFailure?: VcsProcessExitError | VcsProcessTimeoutError;
  readonly versionOutput?: string;
  readonly versionMissing?: boolean;
  readonly targetExists?: boolean;
  readonly onRun?: (input: VcsProcess.VcsProcessInput) => void;
}) {
  const processMock = {
    run: (processInput: VcsProcess.VcsProcessInput) => {
      input.onRun?.(processInput);
      if (processInput.command === "but" && processInput.args[0] === "--version") {
        if (input.versionMissing) {
          return Effect.fail(
            new VcsProcessSpawnError({
              operation: processInput.operation,
              command: processInput.command,
              cwd: processInput.cwd,
              cause: new Error("not found"),
            }),
          );
        }
        return Effect.succeed(processOutput(input.versionOutput ?? "but 0.22.3\n"));
      }
      if (processInput.command === "git" && processInput.args[0] === "rev-parse") {
        return Effect.succeed(processOutput(`${workspaceRoot}\n`));
      }
      if (processInput.command === "git" && processInput.args[0] === "show-ref") {
        return Effect.succeed(
          processOutput("", ChildProcessSpawner.ExitCode(input.targetExists === false ? 1 : 0)),
        );
      }
      if (processInput.command === "but" && processInput.args[0] === "status") {
        if (input.statusFailure) return Effect.fail(input.statusFailure);
        return Effect.succeed(processOutput(input.statusOutput ?? readyStatus));
      }
      return Effect.die(new Error(`Unexpected process: ${processInput.command}`));
    },
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;

  return GitButlerWorkspace.layer.pipe(
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      Layer.succeed(GitButlerProjectRegistry.GitButlerProjectRegistry, {
        registrationStatus: () => Effect.succeed(input.registration ?? "registered"),
      }),
    ),
  );
}

it.effect("does not call GitButler status for an unregistered repository", () => {
  let statusCalls = 0;
  return Effect.gen(function* () {
    const workspace = yield* GitButlerWorkspace.GitButlerWorkspace;
    const result = yield* workspace.read(workspaceRoot);

    assert.strictEqual(result.status, "notConfigured");
    assert.strictEqual(statusCalls, 0);
  }).pipe(
    Effect.provide(
      testLayer({
        registration: "unregistered",
        onRun: (input) => {
          if (input.command === "but" && input.args[0] === "status") statusCalls += 1;
        },
      }),
    ),
  );
});

it.effect("normalizes stacks, review references, conflicts, and file ownership", () => {
  let statusInput: VcsProcess.VcsProcessInput | null = null;
  return Effect.gen(function* () {
    const workspace = yield* GitButlerWorkspace.GitButlerWorkspace;
    const result = yield* workspace.read(`${workspaceRoot}/nested`);

    assert.strictEqual(result.status, "ready");
    if (result.status !== "ready") return;
    assert.strictEqual(result.stacks[0]?.branches[0]?.reviewId, "(#42)");
    assert.strictEqual(result.stacks[0]?.branches[0]?.reviewNumber, 42);
    assert.strictEqual(result.stacks[0]?.branches[0]?.reviewStatus, "passing");
    assert.strictEqual(result.stacks[0]?.branches[0]?.commits[0]?.conflicted, true);
    assert.strictEqual(result.stacks[0]?.assignedChanges[0]?.filePath, "src/conflict.ts");
    assert.strictEqual(result.unassignedChanges[0]?.filePath, "src/unassigned.ts");
    assert.deepStrictEqual(result.conflictedFiles, ["src/conflict.ts"]);
    assert.strictEqual(result.upstreamBehind, 2);
    assert.deepStrictEqual(statusInput?.args, ["status", "-f", "--json"]);
    assert.strictEqual(statusInput?.cwd, workspaceRoot);
    assert.deepStrictEqual(statusInput?.env, { NO_BG_TASKS: "1" });
  }).pipe(
    Effect.provide(
      testLayer({
        onRun: (input) => {
          if (input.command === "but" && input.args[0] === "status") statusInput = input;
        },
      }),
    ),
  );
});

it.effect("returns a ready empty workspace", () =>
  Effect.gen(function* () {
    const workspace = yield* GitButlerWorkspace.GitButlerWorkspace;
    const result = yield* workspace.read(workspaceRoot);

    assert.deepStrictEqual(result, {
      status: "ready",
      version: "0.22.3",
      unassignedChanges: [],
      conflictedFiles: [],
      stacks: [],
      mergeBaseCommitId: "base123",
      upstreamBehind: 0,
      upstreamLastFetched: null,
    });
  }).pipe(
    Effect.provide(
      testLayer({
        statusOutput:
          '{"uncommittedChanges":[],"stacks":[],"mergeBase":{"commitId":"base123","createdAt":"2026-09-08T10:00:00Z","message":"base","authorName":"Maintainer","conflicted":null,"reviewId":null,"changes":null},"upstreamState":{"behind":0,"lastFetched":null}}',
      }),
    ),
  ),
);

it.effect("does not call GitButler status when the target ref is missing", () => {
  let statusCalls = 0;
  return Effect.gen(function* () {
    const workspace = yield* GitButlerWorkspace.GitButlerWorkspace;
    const result = yield* workspace.read(workspaceRoot);

    assert.strictEqual(result.status, "notConfigured");
    assert.strictEqual(statusCalls, 0);
  }).pipe(
    Effect.provide(
      testLayer({
        targetExists: false,
        onRun: (input) => {
          if (input.command === "but" && input.args[0] === "status") statusCalls += 1;
        },
      }),
    ),
  );
});

it.effect("returns explicit missing and incompatible states", () =>
  Effect.gen(function* () {
    const missing = yield* Effect.gen(function* () {
      const workspace = yield* GitButlerWorkspace.GitButlerWorkspace;
      return yield* workspace.read(workspaceRoot);
    }).pipe(Effect.provide(testLayer({ versionMissing: true })));
    const incompatible = yield* Effect.gen(function* () {
      const workspace = yield* GitButlerWorkspace.GitButlerWorkspace;
      return yield* workspace.read(workspaceRoot);
    }).pipe(Effect.provide(testLayer({ versionOutput: "but 0.21.9\n" })));

    assert.strictEqual(missing.status, "missing");
    assert.strictEqual(incompatible.status, "incompatible");
  }),
);

it.effect("fails closed for malformed, non-zero, and timed-out status output", () => {
  const nonZero = new VcsProcessExitError({
    operation: "gitbutler.workspace.status",
    command: "but",
    cwd: workspaceRoot,
    exitCode: 1,
    detail: "Process exited with a non-zero status.",
  });
  const timeout = new VcsProcessTimeoutError({
    operation: "gitbutler.workspace.status",
    command: "but",
    cwd: workspaceRoot,
    timeoutMs: 15_000,
  });
  return Effect.gen(function* () {
    const malformed = yield* Effect.gen(function* () {
      const workspace = yield* GitButlerWorkspace.GitButlerWorkspace;
      return yield* workspace.read(workspaceRoot);
    }).pipe(Effect.provide(testLayer({ statusOutput: "not json" })));
    assert.deepStrictEqual(malformed, {
      status: "error",
      detail: "GitButler returned workspace data that T3 Code could not read.",
    });

    const failed = yield* Effect.gen(function* () {
      const workspace = yield* GitButlerWorkspace.GitButlerWorkspace;
      return yield* workspace.read(workspaceRoot);
    }).pipe(Effect.provide(testLayer({ statusFailure: nonZero })));
    assert.deepStrictEqual(failed, {
      status: "error",
      detail: "GitButler returned workspace data that T3 Code could not read.",
    });

    const timedOut = yield* Effect.gen(function* () {
      const workspace = yield* GitButlerWorkspace.GitButlerWorkspace;
      return yield* workspace.read(workspaceRoot);
    }).pipe(Effect.provide(testLayer({ statusFailure: timeout })));
    assert.deepStrictEqual(timedOut, {
      status: "error",
      detail: "GitButler did not return workspace status before the timeout.",
    });
  });
});
