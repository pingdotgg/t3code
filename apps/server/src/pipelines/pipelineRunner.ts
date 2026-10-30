import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PIPELINE_MAX_STEPS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PipelineError,
  PipelineRunId,
  pipelineDefinitionIssues,
  type OrchestrationV2Actor,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type PipelinePauseReason,
  type PipelineRun,
  type PipelineRunCancelInput,
  type PipelineRevision,
  type PipelineRunRerunInput,
  type PipelineRunReviseInput,
  type PipelineRunResult,
  type PipelineRunRetryInput,
  type PipelineRunSetPauseBeforeInput,
  type PipelineRunStartInput,
  type PipelineRunStep,
  type PipelineRunStepActionInput,
  type PipelineRunStepStatus,
  type PipelineStep,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  exceededDispatchModeLimit,
  type DispatchModes,
} from "../orchestration-v2/DispatchModeLimit.ts";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { forkParked } from "../serverActivation.ts";
import * as PipelineStore from "./PipelineStore.ts";
import {
  pipelineHandoffInstructions,
  pipelineReferencedStepIndexes,
  pipelineRevisionMessage,
  pipelineRevisionSection,
  pipelineUpstreamChangedMessage,
  renderPipelinePrompt,
} from "./pipelineTemplate.ts";
import { makePipelineWorkspace } from "./pipelineWorkspace.ts";

const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const PARENT_TITLE_INPUT_CHARS = 60;

export const pipelineError = (
  message: string,
  ids?: { pipelineId?: PipelineError["pipelineId"]; runId?: PipelineRunId; cause?: unknown },
) =>
  new PipelineError({
    message,
    ...(ids?.pipelineId === undefined ? {} : { pipelineId: ids.pipelineId }),
    ...(ids?.runId === undefined ? {} : { runId: ids.runId }),
    ...(ids?.cause === undefined ? {} : { cause: ids.cause }),
  });

const failureMessage = (cause: unknown, fallback: string) =>
  userFacingDispatchErrorMessage(cause) ?? fallback;

const commandIdFor = (runId: PipelineRunId, ...parts: ReadonlyArray<string | number>) =>
  CommandId.make(`pipeline-run:${runId}:${parts.join(":")}`);

/** Clamps the step's runtime mode to the caller's limit; interaction mode is always the default. */
function clampRuntimeMode(limit: DispatchModes, step: PipelineStep): PipelineStep {
  const exceeded =
    exceededDispatchModeLimit(limit, {
      runtimeMode: step.runtimeMode,
      interactionMode: limit.interactionMode,
    }) === "runtime";
  return exceeded ? { ...step, runtimeMode: limit.runtimeMode } : step;
}

type SettledStep =
  | { readonly _tag: "completed"; readonly output: string }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "deleted" };

type BuiltLaunch =
  | ({ readonly _tag: "ready" } & PipelineStore.StepLaunch)
  | { readonly _tag: "invalid"; readonly message: string };

interface StepExpectation {
  readonly cursor: number;
  readonly attempt: number;
  readonly stepStatus: PipelineRunStepStatus;
}

const pausePatch = (
  now: string,
  reason: PipelinePauseReason,
  error: string | null,
): PipelineStore.PipelineRunPatch => ({
  updatedAt: now,
  status: "paused",
  pauseReason: reason,
  error,
});

/** Moves past the cursor step: completes the run after the last step, or pauses before a gated one. */
const advancePatch = (run: PipelineRun, now: string): PipelineStore.PipelineRunPatch => {
  const next = run.currentStepIndex + 1;
  if (next >= run.steps.length) {
    return {
      updatedAt: now,
      status: "completed",
      pauseReason: null,
      error: null,
      completedAt: now,
    };
  }
  const gated = run.steps[next]?.pauseBefore === true;
  return {
    updatedAt: now,
    currentStepIndex: next,
    status: gated ? "paused" : "running",
    pauseReason: gated ? "awaiting_continue" : null,
    error: null,
  };
};

/** Placeholder until the generated title lands, and the fallback if generation fails. */
const parentTitle = (run: PipelineRun) => {
  const firstLine = run.input.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const excerpt = firstLine.trim().slice(0, PARENT_TITLE_INPUT_CHARS).trim();
  return excerpt.length === 0 ? run.definition.name : excerpt;
};

export const makePipelineRunner = Effect.fn("PipelineRunner.make")(function* (
  /** Called after every run or step write; subscribers re-read. */
  notifyRunChanged: (runId: PipelineRunId) => Effect.Effect<void>,
) {
  const store = yield* PipelineStore.PipelineStore;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const crypto = yield* Crypto.Crypto;
  const workspace = yield* makePipelineWorkspace();

  const permit = yield* Semaphore.make(1);
  const drivers = yield* FiberMap.make<PipelineRunId>();

  /** Write sections re-read state under the permit and are not interruptible once started. */
  const section = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    permit.withPermits(1)(Effect.uninterruptible(effect));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readRun = (runId: PipelineRunId) =>
    store.getRun(runId).pipe(
      Effect.filterOrFail(
        (run): run is PipelineRun => run !== null,
        () => pipelineError("Pipeline run not found.", { runId }),
      ),
    );

  const bestEffort = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(label, { cause: Cause.pretty(cause) }),
      ),
    );

  /** Applies `write` only while the run is still running that exact step attempt. */
  const withGuard = Effect.fn("PipelineRunner.withGuard")(function* <E, R>(
    runId: PipelineRunId,
    expect: StepExpectation,
    write: (run: PipelineRun, now: string) => Effect.Effect<void, E, R>,
  ) {
    return yield* section(
      Effect.gen(function* () {
        const run = yield* readRun(runId);
        const step = run.steps[expect.cursor];
        if (
          run.status !== "running" ||
          run.currentStepIndex !== expect.cursor ||
          step === undefined ||
          step.attempt !== expect.attempt ||
          step.status !== expect.stepStatus
        ) {
          return false;
        }
        yield* write(run, yield* nowIso);
        yield* notifyRunChanged(runId);
        return true;
      }),
    );
  });

  const endStep = Effect.fn("PipelineRunner.endStep")(function* (
    runId: PipelineRunId,
    expect: StepExpectation,
    kind: "failed" | "stopped",
    message: string | null,
  ) {
    return yield* withGuard(runId, expect, (_run, now) =>
      store.updateRunWithSteps(
        runId,
        pausePatch(now, kind === "failed" ? "step_failed" : "step_stopped", message),
        [{ index: expect.cursor, patch: { status: kind, error: message, completedAt: now } }],
      ),
    );
  });

  /**
   * Saves the snapshot a retry can restore. Best effort, and only from the step's first attempt:
   * a later attempt's baseline already holds a failed attempt's leftovers.
   */
  const recordStartCheckpoint = Effect.fn("PipelineRunner.recordStartCheckpoint")(function* (
    runId: PipelineRunId,
    step: PipelineRunStep,
    threadId: ThreadId,
  ) {
    if (step.attempt !== 1 || step.canRestoreWorkspace) return;
    yield* bestEffort(
      "Could not record pipeline step start checkpoint",
      Effect.gen(function* () {
        const start = yield* workspace.findThreadStartCheckpoint(threadId);
        if (start === null) return;
        yield* store.updateStep(runId, step.index, { startCheckpoint: start });
        yield* notifyRunChanged(runId);
      }),
    );
  });

  const stopThread = (
    run: PipelineRun,
    step: PipelineRunStep,
    threadId: ThreadId,
    action: "cancel" | "retry" | "skip" | "rerun" | "revise" | "superseded",
  ) =>
    bestEffort(
      "Could not stop pipeline step thread",
      threads.dispatch({
        type: "thread.stop",
        commandId: commandIdFor(run.id, action, step.stepId, step.attempt),
        threadId,
        reason:
          action === "cancel"
            ? "The pipeline run was stopped."
            : action === "rerun"
              ? "The pipeline was rerun from an earlier step."
              : action === "revise"
                ? "An earlier step of the pipeline was revised."
                : action === "superseded"
                  ? "The pipeline run moved on while this step's message was sent."
                  : `The pipeline step was ${action === "retry" ? "retried" : "skipped"}.`,
      }),
    );

  const stopActiveChild = (run: PipelineRun) => {
    const step = run.steps[run.currentStepIndex];
    if (step === undefined || step.status !== "running" || step.childThreadId === null) {
      return Effect.void;
    }
    return stopThread(run, step, step.childThreadId, "cancel");
  };

  /** A failed, stopped or paused step's thread can still be worked on by hand, so always stop it. */
  const stopCurrentChild = (run: PipelineRun, action: "retry" | "skip" | "rerun" | "revise") => {
    const step = run.steps[run.currentStepIndex];
    if (step === undefined || step.childThreadId === null) return Effect.void;
    return stopThread(run, step, step.childThreadId, action);
  };

  const ensureParent = Effect.fn("PipelineRunner.ensureParent")(function* (
    run: PipelineRun,
  ): Effect.fn.Return<void, PipelineError> {
    const first = run.definition.steps[0];
    if (first === undefined) {
      return yield* pipelineError("Pipeline has no steps.", { runId: run.id });
    }
    const created = yield* threads
      .dispatch({
        type: "thread.create",
        commandId: commandIdFor(run.id, "parent"),
        threadId: run.parentThreadId,
        projectId: run.projectId,
        title: parentTitle(run),
        modelSelection: first.modelSelection,
        runtimeMode: first.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        pipeline: { runId: run.id, stepId: null },
        createdBy: run.createdBy,
        creationSource: run.creationSource,
      })
      .pipe(
        Effect.as(true),
        // A replay or an earlier attempt already created it.
        Effect.catchTags({ OrchestratorThreadAlreadyExistsError: () => Effect.succeed(false) }),
        Effect.mapError((cause) =>
          pipelineError(failureMessage(cause, "Could not create the pipeline's parent thread."), {
            runId: run.id,
            cause,
          }),
        ),
      );
    const titleSource = run.input.trim();
    if (!created || titleSource.length === 0) return;
    // Title the run like a chat: the parent has no messages, so name it from the run's input.
    yield* bestEffort(
      "Could not request the pipeline parent's title",
      threads.dispatch({
        type: "thread.metadata.update",
        commandId: commandIdFor(run.id, "parent-title"),
        threadId: run.parentThreadId,
        regenerateTitle: true,
        titleSource,
      }),
    );
  });

  /** Best effort: lets the parent group with the work once a step's thread has a workspace. */
  const syncParentWorkspace = Effect.fn("PipelineRunner.syncParentWorkspace")(function* (
    run: PipelineRun,
    cursor: number,
    childThreadId: ThreadId,
    attempt: number,
    stage: "launch" | "done",
  ) {
    const stepId = run.steps[cursor]?.stepId;
    if (stepId === undefined) return;
    yield* bestEffort(
      "Could not sync pipeline parent workspace",
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(childThreadId);
        if (shell === null || (shell.branch === null && shell.worktreePath === null)) return;
        const parent = yield* threads.getThreadShell(run.parentThreadId);
        if (
          parent !== null &&
          parent.branch === shell.branch &&
          parent.worktreePath === shell.worktreePath
        ) {
          return;
        }
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: commandIdFor(run.id, "parent-workspace", stepId, attempt, stage),
          threadId: run.parentThreadId,
          branch: shell.branch,
          worktreePath: shell.worktreePath,
        });
      }),
    );
  });

  const waitSettled = Effect.fn("PipelineRunner.waitSettled")(
    function* (
      projectId: ProjectId,
      threadId: ThreadId,
      /** A reused thread already has finished runs; only the run this message started counts. */
      runId?: RunId,
    ): Effect.fn.Return<SettledStep, ThreadManagementService.ThreadManagementError> {
      const waited = yield* Effect.gen(function* () {
        while (true) {
          const result = yield* threads.waitForThread({
            projectId,
            threadId,
            ...(runId === undefined ? {} : { runId }),
            timeoutMs: WAIT_TIMEOUT_MS,
            untilDelegatedWorkSettled: true,
          });
          if (!result.timedOut) return result;
        }
      });
      const run = waited.resultRun ?? waited.run;
      if (run === null) return { _tag: "failed", message: "The step's thread has no run." };
      if (run.status === "interrupted" || run.status === "cancelled") return { _tag: "stopped" };
      if (run.status !== "completed" && run.status !== "failed") {
        return { _tag: "failed", message: `The step's run ended with status ${run.status}.` };
      }
      const records = yield* threads.getProjectThreadRecords(
        { projectId, threadId },
        ["runs", "messages", "turnItems"],
        {
          messageRoles: ["assistant"],
          messageRunIds: [run.id],
          turnItemRunIds: [run.id],
          turnItemTypes: ["assistant_message", "error"],
        },
      );
      const result = subagentResultForRun(records, run);
      if (run.status === "failed") return { _tag: "failed", message: result.text };
      // Without an assistant answer the projection substitutes placeholder text; later prompts get "".
      const answered = result.messageId !== null || result.turnItemId !== null;
      return { _tag: "completed", output: answered ? result.text : "" };
    },
    Effect.catchTags({
      ThreadManagementThreadNotFoundError: () => Effect.succeed<SettledStep>({ _tag: "deleted" }),
    }),
  );

  const handoffFor = (run: PipelineRun, cursor: number) =>
    pipelineHandoffInstructions({
      stepNumber: cursor + 1,
      stepCount: run.definition.steps.length,
      stepName: run.definition.steps[cursor]?.name ?? `Step ${cursor + 1}`,
    });

  const buildLaunch = Effect.fn("PipelineRunner.buildLaunch")(function* (
    run: PipelineRun,
    cursor: number,
    options?: { readonly withRevisions?: boolean },
  ): Effect.fn.Return<BuiltLaunch, PipelineError | OrchestratorV2Error> {
    const outputs = yield* store.getStepOutputs(run.id);
    const rendered = renderPipelinePrompt({
      snapshot: run.definition,
      stepIndex: cursor,
      input: run.input,
      steps: run.steps.map((step) => ({
        status: step.status,
        output: outputs.get(step.index) ?? null,
      })),
    });
    const catchUp =
      options?.withRevisions === true
        ? pipelineRevisionSection(
            run.revisions,
            run.definition.steps.map((step) => step.name),
          )
        : "";
    const prompt = `${rendered.prompt}${catchUp === "" ? "" : `\n\n${catchUp}`}\n\n${handoffFor(run, cursor)}`;
    // Earlier steps' threads share one workspace. Retrying the first step reuses its previous
    // attempt's: re-running the original strategy would try to create the same worktree again.
    const earlier = run.steps.slice(0, cursor).filter((step) => step.childThreadId !== null);
    const current = run.steps[cursor];
    const donors = earlier.length > 0 ? earlier : current?.childThreadId == null ? [] : [current];
    let goneDonor: PipelineRunStep | undefined;
    for (const donor of donors) {
      if (donor.childThreadId === null) continue;
      const shell = yield* threads.getThreadShell(donor.childThreadId);
      if (shell === null || shell.deletedAt !== null) {
        goneDonor ??= donor;
        continue;
      }
      // After a failed worktree setup the thread records no path; joining it would run in the root checkout.
      if (shell.worktreePath === null && run.workspaceStrategy.type !== "root") continue;
      const branch = shell.branch ?? undefined;
      const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
        shell.worktreePath === null
          ? { type: "root", ...(branch === undefined ? {} : { branch }) }
          : {
              type: "existing_worktree",
              worktreePath: shell.worktreePath,
              ...(branch === undefined ? {} : { branch }),
            };
      return { _tag: "ready", prompt, workspaceStrategy };
    }
    if (goneDonor !== undefined && earlier.length > 0) {
      return {
        _tag: "invalid",
        message: `The workspace of step ${goneDonor.index + 1} is gone because its thread was deleted.`,
      };
    }
    return { _tag: "ready", prompt, workspaceStrategy: run.workspaceStrategy };
  });

  const launchStep = Effect.fn("PipelineRunner.launchStep")(function* (
    run: PipelineRun,
    cursor: number,
    attempt: number,
    launch: PipelineStore.StepLaunch,
  ) {
    const step = run.definition.steps[cursor];
    if (step === undefined) return;
    const expect: StepExpectation = { cursor, attempt, stepStatus: "running" };
    // Launch and the write that records its thread are one unit, so an interrupt cannot orphan a thread.
    const childThreadId = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const launched = yield* Effect.result(
          threadLaunch.launch({
            commandId: commandIdFor(run.id, step.id, attempt),
            projectId: run.projectId,
            title:
              `${run.definition.name} · ${step.name}` +
              (attempt > 1 ? ` (attempt ${attempt})` : ""),
            modelSelection: step.modelSelection,
            runtimeMode: step.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            workspaceStrategy: launch.workspaceStrategy,
            initialMessage: {
              messageId: MessageId.make(`pipeline-run-message:${run.id}:${step.id}:${attempt}`),
              text: launch.prompt,
              attachments: [],
            },
            pipeline: { runId: run.id, stepId: step.id },
            createdBy: run.createdBy,
            creationSource: run.creationSource,
          }),
        );
        if (Result.isFailure(launched)) {
          yield* endStep(
            run.id,
            expect,
            "failed",
            failureMessage(launched.failure, "The step's thread could not be started."),
          );
          return null;
        }
        const threadId = launched.success.threadId;
        const applied = yield* withGuard(run.id, expect, () =>
          store.updateStep(run.id, cursor, { childThreadId: threadId }),
        );
        if (!applied) {
          // Cancelled, retried or replaced while launching: nothing else knows this thread.
          const stale = run.steps[cursor];
          if (stale !== undefined) {
            yield* stopThread(run, { ...stale, attempt }, threadId, "cancel");
          }
          return null;
        }
        return threadId;
      }),
    );
    if (childThreadId !== null) {
      yield* syncParentWorkspace(run, cursor, childThreadId, attempt, "launch");
    }
  });

  const threadUsable = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      // A message to an archived thread is refused, so the step launches fresh instead.
      Effect.map(
        (shell) => shell !== null && shell.deletedAt === null && shell.archivedAt === null,
      ),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Tells a later step, in its own thread, that an earlier step was revised. Only outputs its
   * template reads are included, or the revised step's when it reads none that are ready.
   */
  const pingStep = Effect.fn("PipelineRunner.pingStep")(function* (
    run: PipelineRun,
    cursor: number,
    pendingExpect: StepExpectation,
  ) {
    const revised = run.revisions.at(-1);
    if (revised === undefined) return;
    const outputs = yield* store.getStepOutputs(run.id);
    const ready = (index: number) => run.steps[index]?.status === "completed";
    // Steps before every revised one did not change. Chained revisions can leave this step behind
    // more than the latest, so the earliest bounds what is new; an older one included is harmless.
    const earliest = Math.min(...run.revisions.map((revision) => revision.stepIndex));
    const referenced = pipelineReferencedStepIndexes(run.definition, cursor, ready).filter(
      (index) => index >= earliest && ready(index) && outputs.has(index),
    );
    const wanted = referenced.length > 0 ? referenced : [revised.stepIndex];
    const text = pipelineUpstreamChangedMessage({
      revised,
      history: run.revisions,
      stepNames: run.definition.steps.map((step) => step.name),
      outputs: wanted.flatMap((stepIndex) => {
        const output = outputs.get(stepIndex);
        return output === undefined ? [] : [{ stepIndex, output }];
      }),
      handoff: handoffFor(run, cursor),
    });
    if (text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
      yield* endStep(
        run.id,
        pendingExpect,
        "failed",
        `The message is ${text.length} characters, over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} limit. Shorten the earlier output or the feedback, then retry.`,
      );
      return;
    }
    yield* withGuard(run.id, pendingExpect, (_run, now) =>
      store.updateRunWithSteps(run.id, { updatedAt: now, pauseReason: null, error: null }, [
        {
          index: cursor,
          patch: {
            status: "running",
            attempt: pendingExpect.attempt + 1,
            prompt: text,
            output: null,
            handedOff: false,
            revising: true,
            error: null,
            startedAt: now,
            completedAt: null,
          },
        },
      ]),
    );
  });

  /** Sends the saved revision message into the step's existing thread, then settles on its run. */
  const resumeRunning = Effect.fn("PipelineRunner.resumeRunning")(function* (
    run: PipelineRun,
    step: PipelineRunStep,
    childThreadId: ThreadId,
  ) {
    const expect: StepExpectation = {
      cursor: step.index,
      attempt: step.attempt,
      stepStatus: "running",
    };
    const saved = yield* store.getStepLaunch(run.id, step.index);
    if (saved === null) {
      yield* endStep(run.id, expect, "failed", "The step's message was not saved. Retry the step.");
      return;
    }
    const feedback = run.revisions.at(-1);
    // Feedback for this step is sent as its author; a downstream step's catch-up as the run.
    const sender: Pick<
      ThreadManagementService.ThreadManagementSendInput,
      "createdBy" | "creationSource"
    > =
      feedback === undefined || feedback.stepIndex !== step.index
        ? { createdBy: run.createdBy, creationSource: run.creationSource }
        : feedback.author === "user"
          ? { createdBy: "user", creationSource: run.creationSource }
          : { createdBy: "agent", creationSource: "mcp" };
    // Sending and the check that the attempt is still current are one unit, like a launch.
    const sentRunId = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        // Same ids as a launch's first message, so a replay after a restart sends nothing twice.
        const sent = yield* Effect.result(
          threads.sendToThread({
            projectId: run.projectId,
            commandId: commandIdFor(run.id, "revise-message", step.stepId, step.attempt),
            threadId: childThreadId,
            messageId: MessageId.make(
              `pipeline-run-message:${run.id}:${step.stepId}:${step.attempt}`,
            ),
            text: saved.prompt,
            attachments: [],
            mode: "auto",
            ...sender,
          }),
        );
        if (Result.isFailure(sent)) {
          yield* endStep(
            run.id,
            expect,
            "failed",
            failureMessage(sent.failure, "The step's thread could not be reached."),
          );
          return null;
        }
        // A stop that landed while the message was in flight missed its turn; a cancel's id is
        // already used, so this stop needs its own.
        if (!(yield* withGuard(run.id, expect, () => Effect.void))) {
          yield* stopThread(run, step, childThreadId, "superseded");
          return null;
        }
        return sent.success.run.id;
      }),
    );
    if (sentRunId === null) return;
    yield* settleRunning(run, step.index, childThreadId, step.attempt, sentRunId);
  });

  const launchPending = Effect.fn("PipelineRunner.launchPending")(function* (
    run: PipelineRun,
    cursor: number,
  ) {
    const step = run.steps[cursor];
    if (step === undefined) return;
    // Refresh the feeding step's output: a Continue may follow manual refinement in its thread.
    // A handed-off output is the agent's chosen result, so it is never replaced by a later message.
    const feeding = run.steps
      .slice(0, cursor)
      .findLast((candidate) => candidate.status === "completed");
    if (feeding?.childThreadId !== undefined && feeding.childThreadId !== null) {
      const settled = yield* waitSettled(run.projectId, feeding.childThreadId);
      if (settled._tag === "completed") {
        yield* withGuard(
          run.id,
          { cursor, attempt: step.attempt, stepStatus: "pending" },
          (current) =>
            current.steps[feeding.index]?.handedOff === true
              ? Effect.void
              : store.updateStep(run.id, feeding.index, { output: settled.output }),
        );
      }
    }
    const fresh = yield* readRun(run.id);
    const current = fresh.steps[cursor];
    if (
      fresh.status !== "running" ||
      fresh.currentStepIndex !== cursor ||
      current?.status !== "pending"
    ) {
      return;
    }
    const pendingExpect: StepExpectation = {
      cursor,
      attempt: current.attempt,
      stepStatus: "pending",
    };
    const revising = yield* store.isStepRevising(run.id, cursor);
    // Only a step after the revised one catches up in its thread; a retried revised step relaunches.
    const upstreamRevised = (fresh.revisions.at(-1)?.stepIndex ?? cursor) < cursor;
    if (
      revising &&
      upstreamRevised &&
      current.childThreadId !== null &&
      (yield* threadUsable(current.childThreadId))
    ) {
      yield* pingStep(fresh, cursor, pendingExpect);
      return;
    }
    const built = yield* buildLaunch(fresh, cursor, { withRevisions: revising });
    if (built._tag === "invalid") {
      yield* endStep(run.id, pendingExpect, "failed", built.message);
      return;
    }
    if (built.prompt.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
      yield* endStep(
        run.id,
        pendingExpect,
        "failed",
        `The prompt is ${built.prompt.length} characters, over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} limit. Shorten the earlier output or the template, then retry.`,
      );
      return;
    }
    const attempt = current.attempt + 1;
    const written = yield* withGuard(run.id, pendingExpect, (_run, now) =>
      store.updateRunWithSteps(run.id, { updatedAt: now, pauseReason: null, error: null }, [
        {
          index: cursor,
          patch: {
            status: "running",
            attempt,
            childThreadId: null,
            prompt: built.prompt,
            workspaceStrategy: built.workspaceStrategy,
            output: null,
            handedOff: false,
            revising: false,
            error: null,
            startedAt: now,
            completedAt: null,
          },
        },
      ]),
    );
    if (!written) return;
    yield* launchStep(fresh, cursor, attempt, built);
  });

  const settleRunning = Effect.fn("PipelineRunner.settleRunning")(function* (
    run: PipelineRun,
    cursor: number,
    childThreadId: ThreadId,
    attempt: number,
    runId?: RunId,
  ) {
    const settled = yield* waitSettled(run.projectId, childThreadId, runId);
    const expect: StepExpectation = { cursor, attempt, stepStatus: "running" };
    const settling = run.steps[cursor];
    if (settling !== undefined && settled._tag !== "deleted") {
      yield* recordStartCheckpoint(run.id, settling, childThreadId);
    }
    switch (settled._tag) {
      case "completed": {
        let advanced = false;
        const applied = yield* withGuard(run.id, expect, (current, now) => {
          if (current.steps[cursor]?.handedOff === true) {
            advanced = true;
            return store.updateRunWithSteps(run.id, advancePatch(current, now), [
              { index: cursor, patch: { status: "completed", error: null, completedAt: now } },
            ]);
          }
          // No handoff: the agent stopped short (a question, a blocker, unfinished work). The step
          // stays open so its agent can still hand off; the last message is what Continue takes.
          return store.updateRunWithSteps(run.id, pausePatch(now, "awaiting_handoff", null), [
            { index: cursor, patch: { output: settled.output } },
          ]);
        });
        if (applied && advanced) {
          yield* syncParentWorkspace(run, cursor, childThreadId, attempt, "done");
        }
        return;
      }
      case "failed":
        yield* endStep(run.id, expect, "failed", settled.message);
        return;
      case "stopped":
        yield* endStep(run.id, expect, "stopped", null);
        return;
      case "deleted":
        yield* endStep(run.id, expect, "failed", "The step's thread was deleted.");
        return;
    }
  });

  const drive = Effect.fn("PipelineRunner.drive")(function* (runId: PipelineRunId) {
    while (true) {
      const run = yield* readRun(runId);
      if (run.status !== "running") return;
      const cursor = run.currentStepIndex;
      const step = run.steps[cursor];
      if (step === undefined) {
        yield* section(
          Effect.gen(function* () {
            const current = yield* readRun(runId);
            if (current.status !== "running" || current.currentStepIndex !== cursor) return;
            const now = yield* nowIso;
            yield* store.updateRun(runId, {
              updatedAt: now,
              status: "completed",
              pauseReason: null,
              completedAt: now,
            });
            yield* notifyRunChanged(runId);
          }),
        );
        return;
      }
      const expect: StepExpectation = { cursor, attempt: step.attempt, stepStatus: step.status };
      switch (step.status) {
        case "pending":
          yield* launchPending(run, cursor);
          break;
        case "running": {
          if (step.childThreadId === null) {
            // A restart or interrupt landed between the write and the launch; the launch is idempotent.
            const saved = yield* store.getStepLaunch(runId, cursor);
            if (saved === null) {
              yield* endStep(
                runId,
                expect,
                "failed",
                "The step's launch details were not saved. Retry the step.",
              );
            } else {
              yield* launchStep(run, cursor, step.attempt, saved);
            }
          } else if (yield* store.isStepRevising(runId, cursor)) {
            yield* resumeRunning(run, step, step.childThreadId);
          } else {
            yield* settleRunning(run, cursor, step.childThreadId, step.attempt);
          }
          break;
        }
        case "completed":
        case "skipped":
          // A crash between the step write and the cursor write leaves the cursor behind.
          yield* withGuard(runId, expect, (current, now) =>
            store.updateRun(runId, advancePatch(current, now)),
          );
          break;
        case "failed":
        case "stopped":
        case "cancelled":
          yield* withGuard(runId, expect, (_current, now) =>
            store.updateRun(
              runId,
              pausePatch(
                now,
                step.status === "failed" ? "step_failed" : "step_stopped",
                step.error,
              ),
            ),
          );
          break;
      }
    }
  });

  const failDriver = Effect.fn("PipelineRunner.failDriver")(function* (
    runId: PipelineRunId,
    cause: Cause.Cause<unknown>,
  ) {
    yield* Effect.gen(function* () {
      const message = failureMessage(Cause.squash(cause), "The pipeline run stopped unexpectedly.");
      yield* Effect.logError("Pipeline driver failed", { runId, cause: Cause.pretty(cause) });
      yield* section(
        Effect.gen(function* () {
          const run = yield* readRun(runId);
          if (run.status !== "running") return;
          const step = run.steps[run.currentStepIndex];
          const now = yield* nowIso;
          yield* store.updateRunWithSteps(
            runId,
            pausePatch(now, "step_failed", message),
            step !== undefined && (step.status === "pending" || step.status === "running")
              ? [
                  {
                    index: step.index,
                    patch: { status: "failed", error: message, completedAt: now },
                  },
                ]
              : [],
          );
          yield* notifyRunChanged(runId);
        }),
      );
    }).pipe(
      Effect.catchCause((failure) =>
        Effect.logError("Could not record pipeline driver failure", {
          runId,
          cause: Cause.pretty(failure),
        }),
      ),
    );
  });

  const driveSafely = (runId: PipelineRunId) =>
    drive(runId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => failDriver(runId, cause),
      ),
    );

  const hasLiveDriver = (runId: PipelineRunId) =>
    Effect.sync(() => {
      const driver = FiberMap.getUnsafe(drivers, runId);
      return Option.isSome(driver) && driver.value.pollUnsafe() === undefined;
    });

  /**
   * Starts the run's single driver; a previous one is interrupted without waiting. Call it in the
   * same `section` as the write that needs a driver, so a later cancel cannot interrupt this one.
   */
  const wake = (runId: PipelineRunId) =>
    FiberMap.run(drivers, runId, driveSafely(runId), { startImmediately: false }).pipe(
      Effect.asVoid,
    );

  const stopDriver = (runId: PipelineRunId) =>
    Effect.sync(() => {
      const driver = FiberMap.getUnsafe(drivers, runId);
      if (Option.isSome(driver)) driver.value.interruptUnsafe();
    });

  const requireStatus = (
    run: PipelineRun,
    allowed: ReadonlyArray<PipelineRun["status"]>,
    message: string,
  ) =>
    allowed.includes(run.status)
      ? Effect.void
      : Effect.fail(pipelineError(message, { runId: run.id }));

  const requireCursor = (run: PipelineRun, stepIndex: number) =>
    run.currentStepIndex === stepIndex
      ? Effect.void
      : Effect.fail(
          pipelineError(`Step ${stepIndex + 1} is no longer the current step.`, { runId: run.id }),
        );

  /** Retry and skip need the parent thread: the run's steps are grouped under it. */
  const requireParent = Effect.fn("PipelineRunner.requireParent")(function* (
    run: PipelineRun,
  ): Effect.fn.Return<void, PipelineError> {
    const shell = yield* threads.getThreadShell(run.parentThreadId).pipe(
      Effect.mapError((cause) =>
        pipelineError(failureMessage(cause, "Could not read the pipeline's parent thread."), {
          runId: run.id,
          cause,
        }),
      ),
    );
    if (shell === null || shell.deletedAt !== null) {
      return yield* pipelineError("The pipeline's parent thread no longer exists.", {
        runId: run.id,
      });
    }
  });

  const requireRedirectable = Effect.fn("PipelineRunner.requireRedirectable")(function* (
    run: PipelineRun,
    stepIndex: number,
    message: string,
  ): Effect.fn.Return<void, PipelineError> {
    yield* requireStatus(run, ["paused", "cancelled"], message);
    yield* requireCursor(run, stepIndex);
    yield* requireParent(run);
  });

  const result = Effect.fn("PipelineRunner.result")(function* (
    runId: PipelineRunId,
  ): Effect.fn.Return<PipelineRunResult, PipelineError> {
    return { run: yield* readRun(runId) };
  });

  const cancelStart = Effect.fn("PipelineRunner.cancelStart")(function* (
    runId: PipelineRunId,
    message: string,
  ) {
    yield* section(
      Effect.gen(function* () {
        yield* store.updateRun(runId, {
          updatedAt: yield* nowIso,
          status: "cancelled",
          pauseReason: null,
          error: message,
        });
        yield* notifyRunChanged(runId);
      }),
    ).pipe(Effect.ignore);
  });

  /** Creates the parent thread and, for a run that is not waiting on a gate, starts its driver. */
  const launchRun = Effect.fn("PipelineRunner.launchRun")(function* (run: PipelineRun) {
    yield* ensureParent(run).pipe(Effect.tapError((error) => cancelStart(run.id, error.message)));
    yield* notifyRunChanged(run.id);
    if (run.status === "running") yield* wake(run.id);
  });

  const replay = Effect.fn("PipelineRunner.replay")(function* (
    run: PipelineRun,
  ): Effect.fn.Return<PipelineRunResult, PipelineError> {
    // A start that never launched anything and was cancelled carries the reason it failed.
    if (
      run.status === "cancelled" &&
      run.error !== null &&
      run.steps.every((s) => s.attempt === 0)
    ) {
      return yield* pipelineError(run.error, { runId: run.id });
    }
    if (run.status === "running" && !(yield* hasLiveDriver(run.id))) {
      yield* Effect.uninterruptible(launchRun(run));
    }
    return yield* result(run.id);
  });

  const start = Effect.fn("PipelineRunner.start")(function* (
    input: PipelineRunStartInput,
    options?: {
      readonly createdBy?: OrchestrationV2Actor;
      readonly modeLimit?: DispatchModes;
    },
  ) {
    const suffix =
      input.commandId ??
      (yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => pipelineError("Could not generate run id.", { cause }))));
    const runId = PipelineRunId.make(`pipeline-run:${suffix}`);
    const existing = yield* store.getRun(runId);
    if (existing !== null) return yield* replay(existing);

    const definition = yield* store.getDefinition(input.pipelineId);
    if (definition === null) {
      return yield* pipelineError("Pipeline not found.", { pipelineId: input.pipelineId });
    }
    if (definition.steps.length === 0) {
      return yield* pipelineError("Pipeline has no steps.", { pipelineId: input.pipelineId });
    }
    // Saved definitions decode without these rules so a rule change never hides them; running one is refused.
    const issues = pipelineDefinitionIssues(definition.steps);
    if (definition.steps.length > PIPELINE_MAX_STEPS || issues.length > 0) {
      const problems = [
        ...(definition.steps.length > PIPELINE_MAX_STEPS
          ? [`It has more than ${PIPELINE_MAX_STEPS} steps.`]
          : []),
        ...issues.map((issue) => issue.message),
      ];
      return yield* pipelineError(
        `Pipeline "${definition.name}" cannot run until it is fixed: ${problems.join(" ")}`,
        { pipelineId: input.pipelineId },
      );
    }
    const limit = options?.modeLimit;
    const steps = definition.steps.map((step) =>
      limit === undefined ? step : clampRuntimeMode(limit, step),
    );

    const unavailable: string[] = [];
    for (const step of steps) {
      const enabled = yield* threads.isProviderInstanceEnabledForProject({
        projectId: input.projectId,
        instanceId: step.modelSelection.instanceId,
      });
      if (!enabled) unavailable.push(`"${step.name}" (${step.modelSelection.instanceId})`);
    }
    if (unavailable.length > 0) {
      return yield* pipelineError(
        `The provider is not available in this project for ${unavailable.length === 1 ? "step" : "steps"} ${unavailable.join(", ")}. Enable it or edit the pipeline.`,
        { pipelineId: input.pipelineId, runId },
      );
    }

    const parentThreadId = yield* ids.allocate
      .thread({ projectId: input.projectId })
      .pipe(
        Effect.mapError((cause) =>
          pipelineError("Could not allocate the parent thread id.", { runId, cause }),
        ),
      );
    const now = yield* nowIso;
    const gated = steps[0]?.pauseBefore === true;
    // From the insert on, a disconnecting client must not leave a run without a parent or driver.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const inserted = yield* store
          .insertRunWithSteps(
            {
              id: runId,
              pipelineId: definition.id,
              definition: { name: definition.name, steps },
              projectId: input.projectId,
              parentThreadId,
              input: input.input,
              workspaceStrategy: input.workspaceStrategy,
              status: gated ? "paused" : "running",
              pauseReason: gated ? "awaiting_continue" : null,
              error: null,
              currentStepIndex: 0,
              createdBy: options?.createdBy ?? "user",
              creationSource: input.creationSource ?? "web",
              createdAt: now,
              updatedAt: now,
              completedAt: null,
            },
            steps.map((step, index) => ({ index, stepId: step.id, pauseBefore: step.pauseBefore })),
          )
          .pipe(
            Effect.as(true),
            // A concurrent replay of the same commandId wins the insert.
            Effect.catch((error) =>
              store
                .getRun(runId)
                .pipe(
                  Effect.flatMap((raced) =>
                    raced === null ? Effect.fail(error) : Effect.succeed(false),
                  ),
                ),
            ),
          );
        if (!inserted) return yield* result(runId);
        yield* launchRun(yield* readRun(runId));
        return yield* result(runId);
      }),
    );
  });

  const continueRun = Effect.fn("PipelineRunner.continueRun")(function* (
    input: PipelineRunStepActionInput,
  ) {
    yield* section(
      Effect.gen(function* () {
        const run = yield* readRun(input.runId);
        yield* requireStatus(run, ["paused"], "Only a paused run can continue.");
        yield* requireCursor(run, input.stepIndex);
        const step = run.steps[run.currentStepIndex];
        const now = yield* nowIso;
        const resumed = {
          updatedAt: now,
          status: "running",
          pauseReason: null,
          error: null,
        } as const;
        if (run.pauseReason === "awaiting_handoff" && step?.status === "running") {
          // Accept the step without a handoff: its last message becomes the output, and the next
          // launch refreshes it from the thread in case the conversation went on.
          yield* store.updateRunWithSteps(run.id, advancePatch(run, now), [
            { index: step.index, patch: { status: "completed", error: null, completedAt: now } },
          ]);
        } else if (
          step?.status === "failed" ||
          step?.status === "stopped" ||
          step?.status === "cancelled"
        ) {
          if (step.childThreadId === null) {
            return yield* pipelineError(
              "That step has no thread to continue from. Retry or skip it instead.",
              { runId: run.id },
            );
          }
          // Re-wait the same thread and take its latest result.
          yield* store.updateRunWithSteps(run.id, resumed, [
            {
              index: step.index,
              patch: { status: "running", error: null, completedAt: null, revising: false },
            },
          ]);
        } else {
          yield* store.updateRun(run.id, resumed);
        }
        yield* notifyRunChanged(run.id);
        yield* wake(run.id);
      }),
    );
    return yield* result(input.runId);
  });

  const retryStep = Effect.fn("PipelineRunner.retryStep")(function* (input: PipelineRunRetryInput) {
    const message = "Only a paused or cancelled run can retry a step.";
    const restore = input.restoreWorkspace === true;
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const run = yield* readRun(input.runId);
        yield* requireRedirectable(run, input.stepIndex, message);
        const step = run.steps[run.currentStepIndex];
        const threadId = step?.childThreadId ?? null;
        // The last chance to save the snapshot: once the retry starts, the step is on attempt 2.
        if (step !== undefined && threadId !== null) {
          yield* recordStartCheckpoint(run.id, step, threadId);
        }
        const start = restore ? yield* store.getStepStartCheckpoint(run.id, input.stepIndex) : null;
        if (restore && start === null) {
          return yield* pipelineError(
            "This step's starting files were not saved, so they cannot be restored. Retry with the current files instead.",
            { runId: run.id },
          );
        }
        // Stop the old agent before the next attempt can start in the same workspace.
        yield* stopCurrentChild(run, "retry");
        // Stopping is asynchronous, and the agent must not write while its files are put back.
        if (restore && threadId !== null && !(yield* workspace.waitUntilThreadIdle(threadId))) {
          return yield* pipelineError(
            "The step's agent is still stopping. Try again in a moment.",
            {
              runId: run.id,
            },
          );
        }
        yield* section(
          Effect.gen(function* () {
            const current = yield* readRun(input.runId);
            yield* requireRedirectable(current, input.stepIndex, message);
            // Inside the section, so the run cannot change between the check and the restore.
            if (start !== null) {
              yield* workspace.restoreStartCheckpoint({
                runId: current.id,
                stepIndex: current.currentStepIndex,
                attempt: current.steps[current.currentStepIndex]?.attempt ?? 0,
                start,
              });
            }
            const now = yield* nowIso;
            // After a revision the relaunch keeps the feedback. A first step keeps its thread: it
            // is the workspace donor, and launchPending relaunches a revised step instead of pinging.
            const revised = current.revisions.some(
              (revision) => revision.stepIndex <= current.currentStepIndex,
            );
            yield* store.updateRunWithSteps(
              current.id,
              {
                updatedAt: now,
                status: "running",
                pauseReason: null,
                error: null,
                completedAt: null,
              },
              [
                {
                  index: current.currentStepIndex,
                  patch: {
                    status: "pending",
                    error: null,
                    output: null,
                    completedAt: null,
                    revising: revised,
                    ...(revised && current.currentStepIndex > 0 ? { childThreadId: null } : {}),
                  },
                },
              ],
            );
            yield* notifyRunChanged(current.id);
            yield* wake(current.id);
          }),
        );
      }),
    );
    return yield* result(input.runId);
  });

  /**
   * Records a step agent's result. The run advances when the agent's turn ends; a run that paused
   * because an earlier turn ended without a handoff resumes. While the run waits before the next
   * step, the feeding step's agent can still replace its output.
   */
  const handoffStep = Effect.fn("PipelineRunner.handoffStep")(function* (input: {
    readonly runId: PipelineRunId;
    readonly threadId: ThreadId;
    readonly output: string;
  }) {
    yield* section(
      Effect.gen(function* () {
        const run = yield* readRun(input.runId);
        const step = run.steps.find((candidate) => candidate.childThreadId === input.threadId);
        if (step === undefined) {
          return yield* pipelineError(
            "This thread is not the latest attempt of a step in its pipeline run, so it cannot hand off.",
            { runId: run.id },
          );
        }
        const now = yield* nowIso;
        const handedOff = { output: input.output, handedOff: true } as const;
        const current = step.index === run.currentStepIndex && step.status === "running";
        if (current && run.status === "running") {
          yield* store.updateStep(run.id, step.index, handedOff);
        } else if (current && run.status === "paused" && run.pauseReason === "awaiting_handoff") {
          yield* store.updateRunWithSteps(
            run.id,
            { updatedAt: now, status: "running", pauseReason: null, error: null },
            // The thread may have gone on since the revision message; wait for its latest run.
            [{ index: step.index, patch: { ...handedOff, revising: false } }],
          );
          yield* wake(run.id);
        } else if (
          step.status === "completed" &&
          run.status === "paused" &&
          run.pauseReason === "awaiting_continue" &&
          run.currentStepIndex === step.index + 1
        ) {
          yield* store.updateStep(run.id, step.index, handedOff);
        } else {
          return yield* pipelineError(
            `Step ${step.index + 1} cannot hand off now: the run is ${run.status} at step ${run.currentStepIndex + 1}.`,
            { runId: run.id },
          );
        }
        yield* store.updateRun(run.id, { updatedAt: now });
        yield* notifyRunChanged(run.id);
      }),
    );
    return yield* result(input.runId);
  });

  const requireRerunnable = Effect.fn("PipelineRunner.requireRerunnable")(function* (
    run: PipelineRun,
    stepIndex: number,
  ): Effect.fn.Return<void, PipelineError> {
    yield* requireStatus(
      run,
      ["paused", "cancelled", "completed"],
      "Only a paused, cancelled or completed run can rerun a step.",
    );
    if (stepIndex > run.currentStepIndex || stepIndex >= run.steps.length) {
      return yield* pipelineError(`Step ${stepIndex + 1} has not run yet.`, { runId: run.id });
    }
    yield* requireParent(run);
  });

  /** Runs `stepIndex` and every later step again; earlier steps keep their outputs. */
  const rerunFromStep = Effect.fn("PipelineRunner.rerunFromStep")(function* (
    input: PipelineRunRerunInput,
  ) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const run = yield* readRun(input.runId);
        yield* requireRerunnable(run, input.stepIndex);
        // A paused or cancelled step's thread can still be worked on by hand.
        if (run.status !== "completed") yield* stopCurrentChild(run, "rerun");
        yield* section(
          Effect.gen(function* () {
            const current = yield* readRun(input.runId);
            yield* requireRerunnable(current, input.stepIndex);
            const now = yield* nowIso;
            yield* store.updateRunWithSteps(
              current.id,
              {
                updatedAt: now,
                status: "running",
                pauseReason: null,
                error: null,
                currentStepIndex: input.stepIndex,
                completedAt: null,
              },
              current.steps
                .filter((step) => step.index >= input.stepIndex)
                .map((step) => ({
                  index: step.index,
                  patch: {
                    status: "pending",
                    output: null,
                    handedOff: false,
                    revising: false,
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    // Attempts keep counting so each relaunch gets fresh command ids. The rerun
                    // step keeps its thread: a first step relaunches in that thread's workspace.
                    ...(step.index > input.stepIndex ? { childThreadId: null } : {}),
                  },
                })),
            );
            yield* notifyRunChanged(current.id);
            yield* wake(current.id);
          }),
        );
      }),
    );
    return yield* result(input.runId);
  });

  const requireRevisable = Effect.fn("PipelineRunner.requireRevisable")(function* (
    run: PipelineRun,
    stepIndex: number,
  ): Effect.fn.Return<void, PipelineError> {
    const step = run.steps[stepIndex];
    if (step === undefined) {
      return yield* pipelineError(`Step ${stepIndex + 1} is not part of the run.`, {
        runId: run.id,
      });
    }
    if (stepIndex > run.currentStepIndex || step.attempt === 0) {
      return yield* pipelineError(`Step ${stepIndex + 1} has not run yet.`, { runId: run.id });
    }
    if (stepIndex === run.currentStepIndex) {
      const awaitingHandoff =
        run.status === "paused" &&
        run.pauseReason === "awaiting_handoff" &&
        step.status === "running";
      if (step.status === "running" && !awaitingHandoff) {
        return yield* pipelineError(
          `Step ${stepIndex + 1} is running right now. Send it in the step's thread instead.`,
          { runId: run.id },
        );
      }
      if (step.status === "pending") {
        return yield* pipelineError(`Step ${stepIndex + 1} has not started yet.`, {
          runId: run.id,
        });
      }
    }
    yield* requireParent(run);
  });

  /** The message the revised step receives in its own thread, with the run's feedback so far. */
  const revisionMessage = (
    run: PipelineRun,
    revision: PipelineRevision,
    revisions: ReadonlyArray<PipelineRevision>,
  ) =>
    pipelineRevisionMessage({
      revision: {
        ...revision,
        sourceStepName:
          revision.sourceStepId === null
            ? null
            : (run.definition.steps.find((step) => step.id === revision.sourceStepId)?.name ??
              null),
      },
      history: revisions,
      stepNames: run.definition.steps.map((step) => step.name),
      handoff: handoffFor(run, revision.stepIndex),
    });

  /**
   * Sends feedback to an earlier step. It fixes its work in its own thread; every later step then
   * redoes theirs, in their own threads where they still have one. A later step that is running
   * is stopped first. The currently running step is steered in its thread instead.
   */
  const reviseStep = Effect.fn("PipelineRunner.reviseStep")(function* (
    input: PipelineRunReviseInput & { readonly author: PipelineRevision["author"] },
  ) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const run = yield* readRun(input.runId);
        yield* requireRevisable(run, input.stepIndex);
        const target = run.steps[input.stepIndex];
        if (target === undefined) return;
        if (
          input.sourceStepId !== undefined &&
          !run.steps.some((step) => step.stepId === input.sourceStepId)
        ) {
          return yield* pipelineError("The source step is not part of the run.", {
            runId: run.id,
          });
        }
        const newRevision = (createdAt: string): PipelineRevision => ({
          stepIndex: input.stepIndex,
          stepId: target.stepId,
          feedback: input.feedback,
          quote: input.quote === undefined || input.quote.trim() === "" ? null : input.quote,
          sourceStepId: input.sourceStepId ?? null,
          author: input.author,
          createdAt,
        });
        const reuse = target.childThreadId !== null && (yield* threadUsable(target.childThreadId));
        // Checked before anything is stopped, so a rejected revision changes nothing.
        const preview = revisionMessage(run, newRevision(run.updatedAt), [
          ...run.revisions,
          newRevision(run.updatedAt),
        ]);
        if (preview.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
          return yield* pipelineError(
            `The message to the step would be ${preview.length} characters, over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} limit. Shorten the feedback.`,
            { runId: run.id },
          );
        }
        if (run.currentStepIndex > input.stepIndex) {
          const running = run.steps[run.currentStepIndex];
          // Its launch is in flight: there is no thread to stop yet, and the launch would outlive this.
          if (running?.status === "running" && running.childThreadId === null) {
            return yield* pipelineError(
              "The running step is still starting. Try again in a moment.",
              { runId: run.id },
            );
          }
          yield* stopCurrentChild(run, "revise");
          // Two step agents must never write to the shared workspace at once.
          if (
            running?.status === "running" &&
            running.childThreadId !== null &&
            !(yield* workspace.waitUntilThreadIdle(running.childThreadId))
          ) {
            return yield* pipelineError(
              "The running step is still stopping. Try again in a moment.",
              { runId: run.id },
            );
          }
        }
        yield* section(
          Effect.gen(function* () {
            const current = yield* readRun(input.runId);
            yield* requireRevisable(current, input.stepIndex);
            // What was stopped and checked above must still be what runs; the stop's own result
            // may have changed the step's status.
            const latest = current.steps[input.stepIndex];
            if (
              latest === undefined ||
              current.currentStepIndex !== run.currentStepIndex ||
              current.steps[current.currentStepIndex]?.attempt !==
                run.steps[run.currentStepIndex]?.attempt ||
              current.steps[current.currentStepIndex]?.childThreadId !==
                run.steps[run.currentStepIndex]?.childThreadId ||
              latest.attempt !== target.attempt ||
              latest.childThreadId !== target.childThreadId
            ) {
              return yield* pipelineError("The run moved on. Try again.", { runId: current.id });
            }
            const now = yield* nowIso;
            const revision = newRevision(now);
            const revisions = [...current.revisions, revision];
            const targetPatch: PipelineStore.PipelineStepPatch = reuse
              ? {
                  status: "running",
                  attempt: latest.attempt + 1,
                  prompt: revisionMessage(current, revision, revisions),
                  handedOff: false,
                  revising: true,
                  error: null,
                  startedAt: now,
                  completedAt: null,
                }
              : {
                  // No thread to continue in: the driver launches it fresh with the feedback. With
                  // no earlier step's thread, the old one is the workspace donor, as in a retry.
                  status: "pending",
                  ...(current.steps
                    .slice(0, input.stepIndex)
                    .some((step) => step.childThreadId !== null)
                    ? { childThreadId: null }
                    : {}),
                  output: null,
                  handedOff: false,
                  revising: true,
                  error: null,
                  startedAt: null,
                  completedAt: null,
                };
            yield* store.updateRunWithSteps(
              current.id,
              {
                updatedAt: now,
                status: "running",
                pauseReason: null,
                error: null,
                currentStepIndex: input.stepIndex,
                completedAt: null,
                revisions,
              },
              [
                { index: input.stepIndex, patch: targetPatch },
                ...current.steps
                  .filter((step) => step.index > input.stepIndex)
                  .map((step) => ({
                    index: step.index,
                    patch: {
                      status: "pending",
                      handedOff: false,
                      revising: true,
                      error: null,
                      startedAt: null,
                      completedAt: null,
                    } satisfies PipelineStore.PipelineStepPatch,
                  })),
              ],
            );
            yield* notifyRunChanged(current.id);
            yield* wake(current.id);
          }),
        );
      }),
    );
    return yield* result(input.runId);
  });

  const skipStep = Effect.fn("PipelineRunner.skipStep")(function* (
    input: PipelineRunStepActionInput,
  ) {
    const message = "Only a paused or cancelled run can skip a step.";
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const run = yield* readRun(input.runId);
        yield* requireRedirectable(run, input.stepIndex, message);
        yield* stopCurrentChild(run, "skip");
        yield* section(
          Effect.gen(function* () {
            const current = yield* readRun(input.runId);
            yield* requireRedirectable(current, input.stepIndex, message);
            const now = yield* nowIso;
            yield* store.updateRunWithSteps(current.id, advancePatch(current, now), [
              {
                index: current.currentStepIndex,
                patch: { status: "skipped", error: null, completedAt: now },
              },
            ]);
            yield* notifyRunChanged(current.id);
            yield* wake(current.id);
          }),
        );
      }),
    );
    return yield* result(input.runId);
  });

  /** Shared by the cancel action and parent-deletion handling. */
  const cancelRun = Effect.fn("PipelineRunner.cancelRun")(function* (
    runId: PipelineRunId,
    reason: string | null,
  ) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const cancelled = yield* section(
          Effect.gen(function* () {
            const run = yield* readRun(runId);
            if (run.status !== "running" && run.status !== "paused") return null;
            const now = yield* nowIso;
            const step = run.steps[run.currentStepIndex];
            yield* store.updateRunWithSteps(
              runId,
              { updatedAt: now, status: "cancelled", pauseReason: null, error: reason },
              step?.status === "running"
                ? [{ index: step.index, patch: { status: "cancelled", completedAt: now } }]
                : [],
            );
            // Inside the section: a retry that follows cannot have its new driver stopped by this cancel.
            yield* stopDriver(runId);
            yield* notifyRunChanged(runId);
            return run;
          }),
        );
        if (cancelled !== null) {
          yield* stopActiveChild(cancelled);
          const step = cancelled.steps[cancelled.currentStepIndex];
          if (step?.status === "running" && step.childThreadId !== null) {
            yield* recordStartCheckpoint(runId, step, step.childThreadId);
          }
        }
        return cancelled;
      }),
    );
  });

  const cancel = Effect.fn("PipelineRunner.cancel")(function* (input: PipelineRunCancelInput) {
    const run = yield* readRun(input.runId);
    if (run.status === "completed") {
      return yield* pipelineError("The run already completed.", { runId: run.id });
    }
    yield* cancelRun(input.runId, null);
    return yield* result(input.runId);
  });

  const setStepPauseBefore = Effect.fn("PipelineRunner.setStepPauseBefore")(function* (
    input: PipelineRunSetPauseBeforeInput,
  ) {
    yield* section(
      Effect.gen(function* () {
        const run = yield* readRun(input.runId);
        const step = run.steps.find((candidate) => candidate.stepId === input.stepId);
        if (step === undefined) {
          return yield* pipelineError("That step is not part of the run.", { runId: run.id });
        }
        if (run.status === "completed" || step.index <= run.currentStepIndex) {
          return yield* pipelineError(
            "Only steps after the current one can change whether the run pauses before them.",
            { runId: run.id },
          );
        }
        yield* store.updateRunWithSteps(run.id, { updatedAt: yield* nowIso }, [
          { index: step.index, patch: { pauseBefore: input.pauseBefore } },
        ]);
        yield* notifyRunChanged(run.id);
      }),
    );
    return yield* result(input.runId);
  });

  const cancelForDeletedParent = (runId: PipelineRunId) =>
    cancelRun(runId, "The pipeline's parent thread was deleted.");

  const onThreadDeleted = Effect.fn("PipelineRunner.onThreadDeleted")(function* (
    threadId: ThreadId,
  ) {
    yield* bestEffort(
      "Could not cancel pipeline run for deleted parent",
      Effect.gen(function* () {
        const run = yield* store.getRunByParentThreadId(threadId);
        if (run !== null) yield* cancelForDeletedParent(run.id);
      }),
    );
  });

  const recoverRun = Effect.fn("PipelineRunner.recoverRun")(function* (runId: PipelineRunId) {
    yield* bestEffort(
      "Could not recover pipeline run",
      Effect.gen(function* () {
        const run = yield* store.getRun(runId);
        if (run === null) return;
        const shell = yield* threads.getThreadShell(run.parentThreadId);
        if (shell !== null && shell.deletedAt !== null) {
          yield* cancelForDeletedParent(runId);
          return;
        }
        if (shell === null) {
          if (run.steps.some((step) => step.attempt > 0)) {
            yield* cancelForDeletedParent(runId);
            return;
          }
          // Crashed between inserting the run and creating its parent.
          yield* Effect.uninterruptible(launchRun(run));
          return;
        }
        if (run.status === "running" && !(yield* hasLiveDriver(runId))) yield* wake(runId);
      }),
    );
  });

  const sweepLiveRuns = Effect.gen(function* () {
    const liveRunIds = yield* store
      .listRunIdsByStatus(["running", "paused"])
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not list live pipeline runs", { error }).pipe(
            Effect.as([] as ReadonlyArray<PipelineRunId>),
          ),
        ),
      );
    yield* Effect.forEach(liveRunIds, recoverRun, { discard: true });
  });

  /** Watches for parent deletions; the watcher starts before the sweep so no deletion slips between them. */
  const watchDeletions = Effect.gen(function* () {
    const watcher = yield* Effect.forkChild(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        event.type === "thread.deleted" ? onThreadDeleted(event.threadId) : Effect.void,
      ),
    );
    yield* sweepLiveRuns;
    yield* Fiber.join(watcher);
  });

  const startRecovery = Effect.fn("PipelineRunner.startRecovery")(function* () {
    yield* forkParked(
      watchDeletions.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Pipeline recovery stopped; retrying", {
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.retry({
          schedule: Schedule.exponential("1 second").pipe(
            Schedule.modifyDelay(({ duration }) =>
              Effect.succeed(Duration.min(duration, Duration.seconds(30))),
            ),
          ),
        }),
      ),
    );
  });

  return {
    start,
    continueRun,
    retryStep,
    skipStep,
    handoffStep,
    rerunFromStep,
    reviseStep,
    cancel,
    setStepPauseBefore,
    startRecovery,
  };
});
