import { assert, describe, it } from "@effect/vitest";
import type { PullRequestStep, StepRunId, TicketId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { GitHubPort, type GitHubPortShape } from "../Services/GitHubPort.ts";
import { MergeGitPort, type MergeGitResult } from "../Services/TicketMergeService.ts";
import {
  TicketPullRequestService,
  type TicketPullRequestInput,
} from "../Services/TicketPullRequestService.ts";
import {
  WorkflowEventCommitter,
  type WorkflowEventCommitterShape,
} from "../Services/WorkflowEventCommitter.ts";
import type { WorkflowEventInput } from "../Services/WorkflowEventStore.ts";
import { WorkflowIds, type WorkflowIdsShape } from "../Services/WorkflowIds.ts";
import {
  WorkflowReadModel,
  type TicketPrStateRow,
  type WorkflowReadModelShape,
} from "../Services/WorkflowReadModel.ts";
import { TicketPullRequestServiceLive } from "./TicketPullRequestService.ts";

interface RecordedGitCall {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
}

interface OpenPrCall {
  readonly cwd: string;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

interface MergePrCall {
  readonly cwd: string;
  readonly prNumber: number;
  readonly strategy: "squash" | "merge" | "rebase";
  readonly deleteBranch: boolean;
  readonly branch: string;
  readonly remoteName: string;
}

interface Harness {
  readonly gitCalls: Array<RecordedGitCall>;
  readonly openPrCalls: Array<OpenPrCall>;
  readonly mergePrCalls: Array<MergePrCall>;
  readonly committed: Array<WorkflowEventInput>;
  readonly resolveRemoteCalls: { count: number };
  readonly layer: Layer.Layer<TicketPullRequestService>;
}

interface HarnessScript {
  readonly worktreeStatus?: string;
  readonly preflight?: { ok: true } | { ok: false; reason: string };
  readonly defaultBranch?: string;
  readonly remote?: { remoteName: string; repo: string };
  readonly openPrResult?: { number: number; url: string; adopted: boolean };
  // When set, openPr fails with a WorkflowEventStoreError carrying this message
  // (used to exercise the diverged-push blocked path through a resolved layer).
  readonly openPrError?: string;
  // land: the stored PR state for the ticket (null → nothing to land).
  readonly prState?: TicketPrStateRow | null;
  // land: mergePr outcome (defaults to a successful merge).
  readonly mergePrResult?: { ok: true } | { ok: false; reason: string };
}

const TICKET_ID = "ticket-pr" as TicketId;

const prInput = (step: Partial<PullRequestStep> = {}): TicketPullRequestInput => ({
  ticketId: TICKET_ID,
  stepRunId: "step-run-1" as StepRunId,
  repoRoot: "/repo",
  worktreePath: "/repo-worktrees/ticket-pr",
  worktreeRef: "workflow/ticket-pr",
  step: {
    key: "open-pr" as never,
    type: "pullRequest" as const,
    action: "open" as const,
    ...step,
  },
});

const stubReadModel = (script: HarnessScript) =>
  Layer.succeed(WorkflowReadModel, {
    getTicketDetail: () =>
      Effect.succeed({
        ticket: {
          ticketId: "ticket-pr",
          boardId: "board-1",
          title: "Fix login",
          description: "Make login work again",
          currentLaneKey: "open-pr",
          currentLaneEntryToken: "token-1",
          queuedAt: null,
          status: "running",
        },
        steps: [],
        messages: [],
      }),
    getTicketPrState: () => Effect.succeed(script.prState ?? null),
  } as unknown as WorkflowReadModelShape);

const stubIds = Layer.succeed(WorkflowIds, {
  eventId: () => Effect.succeed("event-1"),
} as unknown as WorkflowIdsShape);

const makeHarness = (script: HarnessScript): Harness => {
  const gitCalls: Array<RecordedGitCall> = [];
  const openPrCalls: Array<OpenPrCall> = [];
  const mergePrCalls: Array<MergePrCall> = [];
  const committed: Array<WorkflowEventInput> = [];
  const resolveRemoteCalls = { count: 0 };

  const gitHubPort = Layer.succeed(GitHubPort, {
    preflight: () => Effect.succeed(script.preflight ?? { ok: true }),
    resolveRemote: () =>
      Effect.sync(() => {
        resolveRemoteCalls.count += 1;
        return script.remote ?? { remoteName: "origin", repo: "acme/widgets" };
      }),
    defaultBranch: () => Effect.succeed(script.defaultBranch ?? "main"),
    openPr: (input: OpenPrCall) =>
      Effect.suspend(() => {
        openPrCalls.push({
          cwd: input.cwd,
          branch: input.branch,
          base: input.base,
          title: input.title,
          body: input.body,
          draft: input.draft,
        });
        if (script.openPrError !== undefined) {
          return Effect.fail(new WorkflowEventStoreError({ message: script.openPrError }));
        }
        return Effect.succeed(
          script.openPrResult ?? {
            number: 42,
            url: "https://github.com/acme/widgets/pull/42",
            adopted: false,
          },
        );
      }),
    mergePr: (input: MergePrCall) =>
      Effect.sync(() => {
        mergePrCalls.push({
          cwd: input.cwd,
          prNumber: input.prNumber,
          strategy: input.strategy,
          deleteBranch: input.deleteBranch,
          branch: input.branch,
          remoteName: input.remoteName,
        });
        return script.mergePrResult ?? { ok: true };
      }),
  } as unknown as GitHubPortShape);

  const mergeGitPort = Layer.succeed(MergeGitPort, {
    run: (input: { cwd: string; args: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        gitCalls.push({ cwd: input.cwd, args: input.args });
        const command = input.args[0];
        if (command === "status") {
          return {
            exitCode: 0,
            stdout: script.worktreeStatus ?? "",
            stderr: "",
          } satisfies MergeGitResult;
        }
        return { exitCode: 0, stdout: "", stderr: "" } satisfies MergeGitResult;
      }),
  } as never);

  const committer = Layer.succeed(WorkflowEventCommitter, {
    commit: (event: WorkflowEventInput) =>
      Effect.sync(() => {
        committed.push(event);
      }),
    commitMany: () => Effect.void,
    appendManyUnlocked: () => Effect.succeed([]),
    publishTicketView: () => Effect.void,
  } as WorkflowEventCommitterShape);

  const layer = TicketPullRequestServiceLive.pipe(
    Layer.provideMerge(gitHubPort),
    Layer.provideMerge(mergeGitPort),
    Layer.provideMerge(committer),
    Layer.provideMerge(stubReadModel(script)),
    Layer.provideMerge(stubIds),
  );

  return { gitCalls, openPrCalls, mergePrCalls, committed, resolveRemoteCalls, layer };
};

const runOpen = (harness: Harness, input: TicketPullRequestInput) =>
  Effect.gen(function* () {
    const service = yield* TicketPullRequestService;
    return yield* service.open(input);
  }).pipe(Effect.provide(harness.layer));

const runLand = (harness: Harness, input: TicketPullRequestInput) =>
  Effect.gen(function* () {
    const service = yield* TicketPullRequestService;
    return yield* service.land(input);
  }).pipe(Effect.provide(harness.layer));

const prStateRow = (overrides: Partial<TicketPrStateRow> = {}): TicketPrStateRow => ({
  prNumber: 42,
  prUrl: "https://github.com/acme/widgets/pull/42",
  branch: "workflow/ticket-pr",
  remoteName: "origin",
  repo: "acme/widgets",
  prState: "open",
  lastHeadSha: null,
  lastCiState: null,
  lastReviewDecision: null,
  lastCommentCursor: null,
  ...overrides,
});

describe("TicketPullRequestService open", () => {
  it.effect("snapshots a dirty worktree before opening the PR", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ worktreeStatus: " M src/app.ts\n" });
      const outcome = yield* runOpen(harness, prInput());

      assert.equal(outcome._tag, "completed");
      const statusIndex = harness.gitCalls.findIndex((c) => c.args[0] === "status");
      const addCall = harness.gitCalls.find((c) => c.args[0] === "add");
      const commitCall = harness.gitCalls.find((c) => c.args[0] === "commit");
      assert.ok(statusIndex >= 0);
      assert.deepEqual(addCall?.args, ["add", "-A"]);
      assert.equal(commitCall?.cwd, "/repo-worktrees/ticket-pr");
      assert.deepEqual(commitCall?.args, ["commit", "--no-verify", "-m", "Fix login (ticket-pr)"]);
    }),
  );

  it.effect("purges the per-ticket scratch tree before the status read and snapshot", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ worktreeStatus: " M src/app.ts\n" });
      const outcome = yield* runOpen(harness, prInput());

      assert.equal(outcome._tag, "completed");
      const scratchDir = ".t3/ticket/ticket-pr";
      const rmCall = harness.gitCalls.find(
        (c) => c.args[0] === "rm" && c.args.includes(scratchDir),
      );
      const cleanCall = harness.gitCalls.find(
        (c) => c.args[0] === "clean" && c.args.includes(scratchDir),
      );
      assert.ok(rmCall, "expected a git rm of the scratch tree");
      assert.ok(cleanCall, "expected a git clean of the scratch tree");
      // Cleanup must precede the status read (so the snapshot reflects post-cleanup
      // reality and `git add -A` never stages pipeline scratch into the PR).
      const statusIndex = harness.gitCalls.findIndex((c) => c.args[0] === "status");
      const scratchCleanupIndex = harness.gitCalls.findIndex(
        (c) => (c.args[0] === "rm" || c.args[0] === "clean") && c.args.includes(scratchDir),
      );
      assert.ok(scratchCleanupIndex >= 0);
      assert.ok(scratchCleanupIndex < statusIndex);
    }),
  );

  it.effect("opens a PR with defaults and commits TicketPrOpened", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      const outcome = yield* runOpen(harness, prInput());

      assert.deepEqual(outcome, {
        _tag: "completed",
        output: { prNumber: 42, url: "https://github.com/acme/widgets/pull/42" },
      });

      const call = harness.openPrCalls[0];
      assert.equal(call?.branch, "workflow/ticket-pr");
      assert.equal(call?.base, "main");
      assert.equal(call?.title, "Fix login");
      assert.equal(call?.draft, false);
      assert.ok(call?.body.endsWith("t3-ticket: ticket-pr"));

      assert.equal(harness.committed.length, 1);
      const event = harness.committed[0];
      assert.equal(event?.type, "TicketPrOpened");
      assert.deepEqual((event as { payload: unknown }).payload, {
        stepRunId: "step-run-1",
        prNumber: 42,
        url: "https://github.com/acme/widgets/pull/42",
        branch: "workflow/ticket-pr",
        remoteName: "origin",
        repo: "acme/widgets",
      });
    }),
  );

  it.effect("honors explicit base, templates, and draft", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      const outcome = yield* runOpen(
        harness,
        prInput({
          base: "develop" as never,
          draft: true,
          titleTemplate: "{{ticket.title}} PR" as never,
          bodyTemplate: "Body." as never,
        }),
      );

      assert.equal(outcome._tag, "completed");
      const call = harness.openPrCalls[0];
      assert.equal(call?.base, "develop");
      assert.equal(call?.title, "Fix login PR");
      assert.equal(call?.body, "Body.\n\nt3-ticket: ticket-pr");
      assert.equal(call?.draft, true);
    }),
  );

  it.effect(
    "renders {{ticket.baseRef}} as the RESOLVED default branch when base is omitted (PR #3032)",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ defaultBranch: "trunk" });
        const outcome = yield* runOpen(
          harness,
          prInput({
            // No explicit `base` → falls back to the repo default branch.
            bodyTemplate: "Targets {{ticket.baseRef}}." as never,
          }),
        );

        assert.equal(outcome._tag, "completed");
        const call = harness.openPrCalls[0];
        assert.equal(call?.base, "trunk");
        // Regression: baseRef must be the resolved default branch, NOT "" — the
        // vars used to be built before `base` was resolved.
        assert.equal(call?.body, "Targets trunk.\n\nt3-ticket: ticket-pr");
      }),
  );

  it.effect("commits TicketPrOpened when an existing PR is adopted", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        openPrResult: { number: 7, url: "https://github.com/acme/widgets/pull/7", adopted: true },
      });
      const outcome = yield* runOpen(harness, prInput());

      assert.deepEqual(outcome, {
        _tag: "completed",
        output: { prNumber: 7, url: "https://github.com/acme/widgets/pull/7" },
      });
      assert.equal(harness.committed.length, 1);
      assert.equal(harness.committed[0]?.type, "TicketPrOpened");
    }),
  );

  it.effect("blocks and does nothing when preflight fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        preflight: { ok: false, reason: "gh not authenticated; run gh auth login" },
      });
      const outcome = yield* runOpen(harness, prInput());

      assert.deepEqual(outcome, {
        _tag: "blocked",
        reason: "gh not authenticated; run gh auth login",
      });
      assert.equal(harness.openPrCalls.length, 0);
      assert.equal(harness.committed.length, 0);
      assert.equal(harness.resolveRemoteCalls.count, 0);
      assert.ok(harness.gitCalls.every((c) => c.args[0] !== "commit"));
    }),
  );

  it.effect("blocks on a diverged push and commits nothing", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        openPrError: "branch diverged: remote push rejected",
      });
      const outcome = yield* runOpen(harness, prInput());

      assert.equal(outcome._tag, "blocked");
      assert.ok(outcome._tag === "blocked" && outcome.reason.startsWith("branch diverged"));
      assert.equal(harness.openPrCalls.length, 1);
      assert.equal(harness.committed.length, 0);
      // resolveRemote runs only after the push guard clears.
      assert.equal(harness.resolveRemoteCalls.count, 0);
    }),
  );
});

describe("TicketPullRequestService land", () => {
  const landInput = (step: Partial<PullRequestStep> = {}) =>
    prInput({ action: "land" as const, ...step });

  it.effect("blocks and never merges when there is no recorded PR state", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ prState: null });
      const outcome = yield* runLand(harness, landInput());

      assert.deepEqual(outcome, { _tag: "blocked", reason: "no PR to land" });
      assert.equal(harness.mergePrCalls.length, 0);
    }),
  );

  it.effect("merges with default squash + deleteBranch and completes", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ prState: prStateRow() });
      const outcome = yield* runLand(harness, landInput());

      assert.deepEqual(outcome, { _tag: "completed" });
      assert.equal(harness.mergePrCalls.length, 1);
      const call = harness.mergePrCalls[0];
      assert.equal(call?.cwd, "/repo-worktrees/ticket-pr");
      assert.equal(call?.prNumber, 42);
      assert.equal(call?.strategy, "squash");
      assert.equal(call?.deleteBranch, true);
      assert.equal(call?.branch, "workflow/ticket-pr");
      assert.equal(call?.remoteName, "origin");
    }),
  );

  it.effect("threads through an explicit strategy and deleteBranch:false", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ prState: prStateRow() });
      const outcome = yield* runLand(
        harness,
        landInput({ strategy: "rebase", deleteBranch: false }),
      );

      assert.deepEqual(outcome, { _tag: "completed" });
      const call = harness.mergePrCalls[0];
      assert.equal(call?.strategy, "rebase");
      assert.equal(call?.deleteBranch, false);
    }),
  );

  it.effect("blocks with the gh reason when the PR is not mergeable", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        prState: prStateRow(),
        mergePrResult: { ok: false, reason: "branch protection: review required" },
      });
      const outcome = yield* runLand(harness, landInput());

      assert.deepEqual(outcome, {
        _tag: "blocked",
        reason: "branch protection: review required",
      });
      assert.equal(harness.mergePrCalls.length, 1);
    }),
  );
});
