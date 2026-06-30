import { assert, describe, it } from "@effect/vitest";
import type { MergeStep, TicketId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  MergeGitPort,
  TicketMergeService,
  type MergeGitResult,
} from "../Services/TicketMergeService.ts";
import { WorkflowReadModel, type WorkflowReadModelShape } from "../Services/WorkflowReadModel.ts";
import { TicketMergeServiceLive } from "./TicketMergeService.ts";

interface RecordedGitCall {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
}

interface GitScript {
  readonly worktreeStatus?: string;
  readonly repoStatus?: string;
  readonly branch?: string;
  readonly aheadCount?: string;
  readonly mergeResult?: MergeGitResult;
}

const mergeInput = (step: Partial<MergeStep> = {}) => ({
  ticketId: "ticket-merge" as TicketId,
  repoRoot: "/repo",
  worktreePath: "/repo-worktrees/ticket-merge",
  worktreeRef: "workflow/ticket-merge",
  step: {
    key: "land" as never,
    type: "merge" as const,
    ...step,
  },
});

const stubReadModel = Layer.succeed(WorkflowReadModel, {
  getTicketDetail: () =>
    Effect.succeed({
      ticket: {
        ticketId: "ticket-merge",
        boardId: "board-1",
        title: "Fix login",
        description: null,
        currentLaneKey: "land",
        currentLaneEntryToken: "token-1",
        queuedAt: null,
        status: "running",
      },
      steps: [],
      messages: [],
    }),
} as unknown as WorkflowReadModelShape);

const makeHarness = (script: GitScript) => {
  const calls: Array<RecordedGitCall> = [];
  const layer = TicketMergeServiceLive.pipe(
    Layer.provideMerge(
      Layer.succeed(MergeGitPort, {
        run: (input) =>
          Effect.sync(() => {
            calls.push({ cwd: input.cwd, args: input.args });
            const command = input.args[0];
            if (command === "status") {
              return {
                exitCode: 0,
                stdout:
                  input.cwd === "/repo" ? (script.repoStatus ?? "") : (script.worktreeStatus ?? ""),
                stderr: "",
              };
            }
            if (command === "rev-parse") {
              return { exitCode: 0, stdout: `${script.branch ?? "main"}\n`, stderr: "" };
            }
            if (command === "rev-list") {
              return { exitCode: 0, stdout: `${script.aheadCount ?? "1"}\n`, stderr: "" };
            }
            if (command === "merge" && input.args[1] !== "--abort") {
              return script.mergeResult ?? { exitCode: 0, stdout: "", stderr: "" };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    ),
    Layer.provideMerge(stubReadModel),
  );
  return { calls, layer };
};

describe("TicketMergeService", () => {
  it.effect("merges the ticket branch into the checked-out branch", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      const outcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(mergeInput());
      }).pipe(Effect.provide(harness.layer));

      assert.deepEqual(outcome, { _tag: "completed" });
      const mergeCall = harness.calls.find(
        (call) => call.args[0] === "merge" && call.args[1] !== "--abort",
      );
      assert.deepEqual(mergeCall?.args, [
        "merge",
        "--no-ff",
        "--no-verify",
        "-m",
        "Fix login (ticket-merge)",
        "workflow/ticket-merge",
      ]);
      assert.equal(mergeCall?.cwd, "/repo");
    }),
  );

  it.effect("snapshots dirty worktree changes before merging", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ worktreeStatus: " M src/app.ts\n" });
      const outcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(mergeInput({ commitMessage: "Land it" }));
      }).pipe(Effect.provide(harness.layer));

      assert.deepEqual(outcome, { _tag: "completed" });
      const commitCall = harness.calls.find((call) => call.args[0] === "commit");
      assert.equal(commitCall?.cwd, "/repo-worktrees/ticket-merge");
      assert.deepEqual(commitCall?.args, ["commit", "--no-verify", "-m", "Land it"]);
      assert.ok(harness.calls.some((call) => call.args[0] === "add"));
    }),
  );

  it.effect("blocks when the repo working tree is dirty", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ repoStatus: " M README.md\n" });
      const outcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(mergeInput());
      }).pipe(Effect.provide(harness.layer));

      assert.equal(outcome._tag, "blocked");
      assert.ok(harness.calls.every((call) => call.args[0] !== "merge"));
    }),
  );

  it.effect("blocks on detached HEAD or mismatched target branch", () =>
    Effect.gen(function* () {
      const detached = makeHarness({ branch: "HEAD" });
      const detachedOutcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(mergeInput());
      }).pipe(Effect.provide(detached.layer));
      assert.equal(detachedOutcome._tag, "blocked");

      const mismatch = makeHarness({ branch: "feature/x" });
      const mismatchOutcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(mergeInput({ target: "main" }));
      }).pipe(Effect.provide(mismatch.layer));
      assert.equal(mismatchOutcome._tag, "blocked");
      assert.ok(mismatchOutcome._tag === "blocked" && mismatchOutcome.reason.includes("feature/x"));
    }),
  );

  it.effect("completes without merging when there is nothing to merge", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ aheadCount: "0" });
      const outcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(mergeInput());
      }).pipe(Effect.provide(harness.layer));

      assert.deepEqual(outcome, { _tag: "completed" });
      assert.ok(harness.calls.every((call) => call.args[0] !== "merge"));
    }),
  );

  it.effect("aborts and blocks on merge conflicts", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        mergeResult: {
          exitCode: 1,
          stdout: "CONFLICT (content): Merge conflict in src/app.ts\n",
          stderr: "",
        },
      });
      const outcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(mergeInput());
      }).pipe(Effect.provide(harness.layer));

      assert.equal(outcome._tag, "blocked");
      assert.ok(outcome._tag === "blocked" && outcome.reason.includes("src/app.ts"));
      assert.ok(
        harness.calls.some((call) => call.args[0] === "merge" && call.args[1] === "--abort"),
      );
    }),
  );
});

describe("TicketMergeService cleanup", () => {
  it.effect("removes cleanup paths from the worktree before the snapshot commit", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ worktreeStatus: " M src/app.ts\n" });
      const outcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(mergeInput({ cleanupPaths: ["PLAN.md", "REVIEW.md"] as never }));
      }).pipe(Effect.provide(harness.layer));

      assert.deepEqual(outcome, { _tag: "completed" });
      const cleanupCalls = harness.calls.filter(
        (call) => call.args[0] === "rm" || call.args[0] === "clean",
      );
      // 2 unconditional scratch-tree cleanups + 2 each for PLAN.md / REVIEW.md.
      assert.equal(cleanupCalls.length, 6);
      assert.ok(cleanupCalls.every((call) => call.cwd === "/repo-worktrees/ticket-merge"));
      assert.ok(
        cleanupCalls.some((call) => call.args[0] === "rm" && call.args.includes("PLAN.md")),
      );
      assert.ok(
        cleanupCalls.some((call) => call.args[0] === "clean" && call.args.includes("REVIEW.md")),
      );
      const firstCommitIndex = harness.calls.findIndex((call) => call.args[0] === "commit");
      const lastCleanupIndex = harness.calls.reduce(
        (latest, call, index) =>
          call.args[0] === "rm" || call.args[0] === "clean" ? index : latest,
        -1,
      );
      assert.ok(lastCleanupIndex < firstCommitIndex);
    }),
  );
});

describe("TicketMergeService scratch cleanup", () => {
  it.effect("unconditionally removes the per-ticket scratch tree before the snapshot", () =>
    Effect.gen(function* () {
      // No cleanupPaths configured — scratch files (DESCRIPTION.md, handoff/,
      // design/) must still be purged from the whole `.t3/ticket/<id>` tree.
      const harness = makeHarness({ worktreeStatus: " M src/app.ts\n" });
      const outcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(mergeInput());
      }).pipe(Effect.provide(harness.layer));

      assert.deepEqual(outcome, { _tag: "completed" });
      const scratchDir = ".t3/ticket/ticket-merge";
      const rmCall = harness.calls.find(
        (call) => call.args[0] === "rm" && call.args.includes(scratchDir),
      );
      const cleanCall = harness.calls.find(
        (call) => call.args[0] === "clean" && call.args.includes(scratchDir),
      );
      assert.ok(rmCall, "expected a git rm of the scratch tree");
      assert.ok(cleanCall, "expected a git clean of the scratch tree");
      assert.equal(rmCall?.cwd, "/repo-worktrees/ticket-merge");
      // The cleanup must precede the snapshot commit so spilled files never land
      // in the merged branch / PR diff.
      const firstCommitIndex = harness.calls.findIndex((call) => call.args[0] === "commit");
      const scratchCleanupIndex = harness.calls.findIndex(
        (call) =>
          (call.args[0] === "rm" || call.args[0] === "clean") && call.args.includes(scratchDir),
      );
      assert.ok(scratchCleanupIndex >= 0);
      assert.ok(scratchCleanupIndex < firstCommitIndex);
    }),
  );
});

describe("TicketMergeService cleanup templating", () => {
  it.effect("substitutes the ticket id into cleanup paths and removes directories", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      const outcome = yield* Effect.gen(function* () {
        const merges = yield* TicketMergeService;
        return yield* merges.merge(
          mergeInput({ cleanupPaths: [".t3/ticket/{{ticket.id}}"] as never }),
        );
      }).pipe(Effect.provide(harness.layer));

      assert.deepEqual(outcome, { _tag: "completed" });
      const rmCall = harness.calls.find(
        (call) => call.args[0] === "rm" && call.args.includes(".t3/ticket/ticket-merge"),
      );
      assert.ok(rmCall?.args.includes(".t3/ticket/ticket-merge"));
      assert.ok(rmCall?.args.includes("-r"));
      const cleanCall = harness.calls.find(
        (call) => call.args[0] === "clean" && call.args.includes(".t3/ticket/ticket-merge"),
      );
      assert.ok(cleanCall?.args.includes(".t3/ticket/ticket-merge"));
      assert.ok(cleanCall?.args.includes("-d"));
    }),
  );
});
