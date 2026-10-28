import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PipelineError,
  PipelineRunId,
  type OrchestrationV2Actor,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type PipelinePauseReason,
  type PipelineRun,
  type PipelineRunCancelInput,
  type PipelineRunResult,
  type PipelineRunSetPauseBeforeInput,
  type PipelineRunStartInput,
  type PipelineRunStepActionInput,
  type PipelineRunStepStatus,
  type PipelineStep,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  exceededDispatchModeLimit,
  type DispatchModes,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import type * as PipelineStore from "./PipelineStore.ts";
import { renderPipelinePrompt } from "./pipelineTemplate.ts";

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

/** Joins an error with its causes so a launch failure names its real reason. */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth += 1) {
    const message =
      current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (message.length > 0 && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(": ") || "Unknown error.";
}

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
  | {
      readonly _tag: "ready";
      readonly prompt: string;
      readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
    }
  | { readonly _tag: "invalid"; readonly message: string };

interface StepExpectation {
  readonly cursor: number;
  readonly attempt: number;
  readonly stepStatus: PipelineRunStepStatus;
}

export interface PipelineRunnerDependencies {
  readonly store: PipelineStore.PipelineStoreShape;
  readonly threadLaunch: ThreadLaunchService.ThreadLaunchService["Service"];
  readonly threads: ThreadManagementService.ThreadManagementServiceShape;
  readonly ids: IdAllocator.IdAllocatorV2["Service"];
  readonly crypto: Crypto.Crypto;
  /** Called after every run or step write; subscribers re-read. */
  readonly notifyRunChanged: (runId: PipelineRunId) => Effect.Effect<void>;
}

export const makePipelineRunner = Effect.fn("PipelineRunner.make")(function* (
  deps: PipelineRunnerDependencies,
) {
  const { store, threadLaunch, threads, ids, crypto, notifyRunChanged } = deps;

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
  const withGuard = <E, R>(
    runId: PipelineRunId,
    expect: StepExpectation,
    write: (run: PipelineRun, now: string) => Effect.Effect<void, E, R>,
  ) =>
    section(
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

  const pauseRun = (
    runId: PipelineRunId,
    now: string,
    reason: PipelinePauseReason,
    error: string | null,
  ) =>
    store.updateRun(runId, {
      updatedAt: now,
      status: "paused",
      pauseReason: reason,
      error,
    });

  /** Moves past the cursor step: completes the run after the last step, or pauses before a gated one. */
  const advance = (run: PipelineRun, now: string) => {
    const next = run.currentStepIndex + 1;
    if (next >= run.steps.length) {
      return store.updateRun(run.id, {
        updatedAt: now,
        status: "completed",
        pauseReason: null,
        error: null,
        completedAt: now,
      });
    }
    const gated = run.steps[next]?.pauseBefore === true;
    return store.updateRun(run.id, {
      updatedAt: now,
      currentStepIndex: next,
      status: gated ? "paused" : "running",
      pauseReason: gated ? "awaiting_continue" : null,
      error: null,
    });
  };

  const endStep = (
    runId: PipelineRunId,
    expect: StepExpectation,
    kind: "failed" | "stopped",
    message: string | null,
  ) =>
    withGuard(runId, expect, (_run, now) =>
      Effect.gen(function* () {
        yield* store.updateStep(runId, expect.cursor, {
          status: kind,
          error: message,
          completedAt: now,
        });
        yield* pauseRun(runId, now, kind === "failed" ? "step_failed" : "step_stopped", message);
      }),
    );

  const stopThread = (runId: PipelineRunId, stepId: string, attempt: number, threadId: ThreadId) =>
    bestEffort(
      "Could not stop pipeline step thread",
      threads.dispatch({
        type: "thread.stop",
        commandId: commandIdFor(runId, "cancel", stepId, attempt),
        threadId,
        reason: "The pipeline run was stopped.",
      }),
    );

  const stopActiveChild = (run: PipelineRun) => {
    const step = run.steps[run.currentStepIndex];
    if (step === undefined || step.status !== "running" || step.childThreadId === null) {
      return Effect.void;
    }
    return stopThread(run.id, step.stepId, step.attempt, step.childThreadId);
  };

  const parentTitle = (run: PipelineRun) => {
    const firstLine = run.input.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
    const excerpt = firstLine.trim().slice(0, PARENT_TITLE_INPUT_CHARS).trim();
    return excerpt.length === 0 ? run.definition.name : `${run.definition.name}: ${excerpt}`;
  };

  const ensureParent = (run: PipelineRun): Effect.Effect<void, PipelineError> => {
    const first = run.definition.steps[0];
    if (first === undefined)
      return Effect.fail(pipelineError("Pipeline has no steps.", { runId: run.id }));
    return threads
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
        Effect.asVoid,
        // A replay or an earlier attempt already created it.
        Effect.catchTags({ OrchestratorThreadAlreadyExistsError: () => Effect.void }),
        Effect.mapError((cause) =>
          pipelineError(`Could not create the pipeline's parent thread: ${describeError(cause)}`, {
            runId: run.id,
            cause,
          }),
        ),
      );
  };

  /** Best effort: lets the parent group with the work once the workspace owner has a path. */
  const syncParentWorkspace = (
    run: PipelineRun,
    cursor: number,
    childThreadId: ThreadId,
    attempt: number,
    stage: "launch" | "done",
  ) => {
    const owner = run.steps.slice(0, cursor).every((step) => step.childThreadId === null);
    const stepId = run.steps[cursor]?.stepId;
    if (!owner || stepId === undefined) return Effect.void;
    return bestEffort(
      "Could not sync pipeline parent workspace",
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(childThreadId);
        if (shell === null || (shell.branch === null && shell.worktreePath === null)) return;
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: commandIdFor(run.id, "parent-workspace", stepId, attempt, stage),
          threadId: run.parentThreadId,
          branch: shell.branch,
          worktreePath: shell.worktreePath,
        });
      }),
    );
  };

  const waitSettled = Effect.fn("PipelineRunner.waitSettled")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    return yield* Effect.gen(function* () {
      const waited = yield* Effect.gen(function* () {
        while (true) {
          const result = yield* threads.waitForThread({
            projectId,
            threadId,
            timeoutMs: WAIT_TIMEOUT_MS,
            untilDelegatedWorkSettled: true,
          });
          if (!result.timedOut) return result;
        }
      });
      const run = waited.resultRun ?? waited.run;
      if (run === null) {
        return { _tag: "failed", message: "The step's thread has no run." } as SettledStep;
      }
      if (run.status === "interrupted" || run.status === "cancelled") {
        return { _tag: "stopped" } as SettledStep;
      }
      if (run.status !== "completed" && run.status !== "failed") {
        return {
          _tag: "failed",
          message: `The step's run ended with status ${run.status}.`,
        } as SettledStep;
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
      const text = subagentResultForRun(records, run).text;
      return run.status === "failed"
        ? ({ _tag: "failed", message: text } as SettledStep)
        : ({ _tag: "completed", output: text } as SettledStep);
    }).pipe(
      Effect.catchTags({
        ThreadManagementThreadNotFoundError: () =>
          Effect.succeed({ _tag: "deleted" } as SettledStep),
      }),
    );
  });

  const buildLaunch = Effect.fn("PipelineRunner.buildLaunch")(function* (
    run: PipelineRun,
    cursor: number,
  ) {
    const outputs = yield* store.getStepOutputs(run.id);
    const { prompt } = renderPipelinePrompt({
      snapshot: run.definition,
      stepIndex: cursor,
      input: run.input,
      steps: run.steps.map((step) => ({
        status: step.status,
        output: outputs.get(step.index) ?? null,
      })),
    });
    // The first step with a thread owns the workspace; later steps join it.
    const owner = run.steps.slice(0, cursor).find((step) => step.childThreadId !== null);
    // Retrying the owner reuses its previous attempt's workspace: re-running the original
    // strategy would try to create the same worktree branch again.
    const previousAttempt = owner === undefined ? run.steps[cursor] : undefined;
    const workspaceThreadId = owner?.childThreadId ?? previousAttempt?.childThreadId ?? null;
    if (workspaceThreadId === null) {
      return { _tag: "ready", prompt, workspaceStrategy: run.workspaceStrategy } as BuiltLaunch;
    }
    const shell = yield* threads.getThreadShell(workspaceThreadId);
    if (shell === null || shell.deletedAt !== null) {
      if (owner === undefined) {
        return { _tag: "ready", prompt, workspaceStrategy: run.workspaceStrategy } as BuiltLaunch;
      }
      return {
        _tag: "invalid",
        message: `The workspace of step ${owner.index + 1} is gone because its thread was deleted.`,
      } as BuiltLaunch;
    }
    const branch = shell.branch ?? undefined;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      shell.worktreePath === null
        ? { type: "root", ...(branch === undefined ? {} : { branch }) }
        : {
            type: "existing_worktree",
            worktreePath: shell.worktreePath,
            ...(branch === undefined ? {} : { branch }),
          };
    return { _tag: "ready", prompt, workspaceStrategy } as BuiltLaunch;
  });

  const launchStep = Effect.fn("PipelineRunner.launchStep")(function* (
    run: PipelineRun,
    cursor: number,
    attempt: number,
    built: Extract<BuiltLaunch, { _tag: "ready" }>,
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
            workspaceStrategy: built.workspaceStrategy,
            initialMessage: {
              messageId: MessageId.make(`pipeline-run-message:${run.id}:${step.id}:${attempt}`),
              text: built.prompt,
              attachments: [],
            },
            pipeline: { runId: run.id, stepId: step.id },
            createdBy: run.createdBy,
            creationSource: run.creationSource,
          }),
        );
        if (Result.isFailure(launched)) {
          yield* endStep(run.id, expect, "failed", describeError(launched.failure));
          return null;
        }
        const threadId = launched.success.threadId;
        const applied = yield* withGuard(run.id, expect, () =>
          store.updateStep(run.id, cursor, { childThreadId: threadId }),
        );
        if (!applied) {
          // Cancelled, retried or replaced while launching: nothing else knows this thread.
          yield* stopThread(run.id, step.id, attempt, threadId);
          return null;
        }
        return threadId;
      }),
    );
    if (childThreadId !== null) {
      yield* syncParentWorkspace(run, cursor, childThreadId, attempt, "launch");
    }
  });

  const launchPending = Effect.fn("PipelineRunner.launchPending")(function* (
    run: PipelineRun,
    cursor: number,
  ) {
    const step = run.steps[cursor];
    if (step === undefined) return;
    // Refresh the feeding step's output: a Continue may follow manual refinement in its thread.
    const feeding = run.steps
      .slice(0, cursor)
      .findLast((candidate) => candidate.status === "completed");
    if (feeding?.childThreadId !== undefined && feeding.childThreadId !== null) {
      const settled = yield* waitSettled(run.projectId, feeding.childThreadId);
      if (settled._tag === "completed") {
        yield* withGuard(run.id, { cursor, attempt: step.attempt, stepStatus: "pending" }, () =>
          store.updateStep(run.id, feeding.index, { output: settled.output }),
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
    const built = yield* buildLaunch(fresh, cursor);
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
      Effect.gen(function* () {
        yield* store.updateStep(run.id, cursor, {
          status: "running",
          attempt,
          childThreadId: null,
          prompt: built.prompt,
          output: null,
          error: null,
          startedAt: now,
          completedAt: null,
        });
        yield* store.updateRun(run.id, {
          updatedAt: now,
          pauseReason: null,
          error: null,
        });
      }),
    );
    if (!written) return;
    yield* launchStep(fresh, cursor, attempt, built);
  });

  const settleRunning = Effect.fn("PipelineRunner.settleRunning")(function* (
    run: PipelineRun,
    cursor: number,
    childThreadId: ThreadId,
    attempt: number,
  ) {
    const settled = yield* waitSettled(run.projectId, childThreadId);
    const expect: StepExpectation = { cursor, attempt, stepStatus: "running" };
    switch (settled._tag) {
      case "completed": {
        const applied = yield* withGuard(run.id, expect, (current, now) =>
          Effect.gen(function* () {
            yield* store.updateStep(run.id, cursor, {
              status: "completed",
              output: settled.output,
              error: null,
              completedAt: now,
            });
            yield* advance(current, now);
          }),
        );
        if (applied) yield* syncParentWorkspace(run, cursor, childThreadId, attempt, "done");
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
            const built = yield* buildLaunch(run, cursor);
            if (built._tag === "invalid") {
              yield* endStep(runId, expect, "failed", built.message);
            } else {
              yield* launchStep(run, cursor, step.attempt, built);
            }
          } else {
            yield* settleRunning(run, cursor, step.childThreadId, step.attempt);
          }
          break;
        }
        case "completed":
        case "skipped":
          // A crash between the step write and the cursor write leaves the cursor behind.
          yield* withGuard(runId, expect, (current, now) => advance(current, now));
          break;
        case "failed":
        case "stopped":
        case "cancelled":
          yield* withGuard(runId, expect, (_current, now) =>
            pauseRun(
              runId,
              now,
              step.status === "failed" ? "step_failed" : "step_stopped",
              step.error,
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
      const message = describeError(Cause.squash(cause));
      yield* Effect.logError("Pipeline driver failed", { runId, cause: Cause.pretty(cause) });
      yield* section(
        Effect.gen(function* () {
          const run = yield* readRun(runId);
          if (run.status !== "running") return;
          const step = run.steps[run.currentStepIndex];
          const now = yield* nowIso;
          if (step !== undefined && (step.status === "pending" || step.status === "running")) {
            yield* store.updateStep(runId, step.index, {
              status: "failed",
              error: message,
              completedAt: now,
            });
          }
          yield* pauseRun(runId, now, "step_failed", message);
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

  /** Starts (or restarts) the run's single driver; the previous one is interrupted first. */
  const wake = (runId: PipelineRunId) =>
    FiberMap.remove(drivers, runId).pipe(
      Effect.andThen(FiberMap.run(drivers, runId, driveSafely(runId))),
      Effect.asVoid,
    );

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

  const result = Effect.fn("PipelineRunner.result")(function* (
    runId: PipelineRunId,
  ): Effect.fn.Return<PipelineRunResult, PipelineError> {
    return { run: yield* readRun(runId) };
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
    if (existing !== null) return { run: existing };

    const definition = yield* store.getDefinition(input.pipelineId);
    if (definition === null) {
      return yield* pipelineError("Pipeline not found.", { pipelineId: input.pipelineId });
    }
    if (definition.steps.length === 0) {
      return yield* pipelineError("Pipeline has no steps.", { pipelineId: input.pipelineId });
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

    const created = yield* readRun(runId);
    yield* ensureParent(created).pipe(
      Effect.tapError((error) =>
        section(
          Effect.gen(function* () {
            yield* store.updateRun(runId, {
              updatedAt: yield* nowIso,
              status: "cancelled",
              pauseReason: null,
              error: error.message,
            });
            yield* notifyRunChanged(runId);
          }),
        ).pipe(Effect.ignore),
      ),
    );
    yield* notifyRunChanged(runId);
    if (!gated) yield* wake(runId);
    return yield* result(runId);
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
        if (step?.status === "failed" || step?.status === "stopped") {
          if (step.childThreadId === null) {
            return yield* pipelineError(
              "That step has no thread to continue from. Retry or skip it instead.",
              { runId: run.id },
            );
          }
          // Re-wait the same thread and take its latest result.
          yield* store.updateStep(run.id, step.index, {
            status: "running",
            error: null,
            completedAt: null,
          });
        }
        yield* store.updateRun(run.id, {
          updatedAt: now,
          status: "running",
          pauseReason: null,
          error: null,
        });
        yield* notifyRunChanged(run.id);
      }),
    );
    yield* wake(input.runId);
    return yield* result(input.runId);
  });

  const retryStep = Effect.fn("PipelineRunner.retryStep")(function* (
    input: PipelineRunStepActionInput,
  ) {
    const before = yield* section(
      Effect.gen(function* () {
        const run = yield* readRun(input.runId);
        yield* requireStatus(
          run,
          ["paused", "cancelled"],
          "Only a paused or cancelled run can retry a step.",
        );
        yield* requireCursor(run, input.stepIndex);
        const now = yield* nowIso;
        yield* store.updateStep(run.id, run.currentStepIndex, {
          status: "pending",
          error: null,
          output: null,
          completedAt: null,
        });
        yield* store.updateRun(run.id, {
          updatedAt: now,
          status: "running",
          pauseReason: null,
          error: null,
          completedAt: null,
        });
        yield* notifyRunChanged(run.id);
        return run;
      }),
    );
    yield* stopActiveChild(before);
    yield* wake(input.runId);
    return yield* result(input.runId);
  });

  const skipStep = Effect.fn("PipelineRunner.skipStep")(function* (
    input: PipelineRunStepActionInput,
  ) {
    const before = yield* section(
      Effect.gen(function* () {
        const run = yield* readRun(input.runId);
        yield* requireStatus(
          run,
          ["paused", "cancelled"],
          "Only a paused or cancelled run can skip a step.",
        );
        yield* requireCursor(run, input.stepIndex);
        const now = yield* nowIso;
        yield* store.updateStep(run.id, run.currentStepIndex, {
          status: "skipped",
          error: null,
          completedAt: now,
        });
        yield* advance(run, now);
        yield* notifyRunChanged(run.id);
        return run;
      }),
    );
    yield* stopActiveChild(before);
    yield* wake(input.runId);
    return yield* result(input.runId);
  });

  /** Shared by the cancel action and parent-deletion handling. */
  const cancelRun = Effect.fn("PipelineRunner.cancelRun")(function* (
    runId: PipelineRunId,
    reason: string | null,
  ) {
    const cancelled = yield* section(
      Effect.gen(function* () {
        const run = yield* readRun(runId);
        if (run.status !== "running" && run.status !== "paused") return null;
        const now = yield* nowIso;
        const step = run.steps[run.currentStepIndex];
        if (step?.status === "running") {
          yield* store.updateStep(runId, step.index, { status: "cancelled", completedAt: now });
        }
        yield* store.updateRun(runId, {
          updatedAt: now,
          status: "cancelled",
          pauseReason: null,
          error: reason,
        });
        yield* notifyRunChanged(runId);
        return run;
      }),
    );
    if (cancelled !== null) {
      yield* FiberMap.remove(drivers, runId);
      yield* stopActiveChild(cancelled);
    }
    return cancelled;
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
        const cursor = run.currentStepIndex;
        const editable =
          run.status !== "completed" &&
          (step.index > cursor || (step.index === cursor && step.status === "pending"));
        if (!editable) {
          return yield* pipelineError("That step has already started.", { runId: run.id });
        }
        yield* store.updateStep(run.id, step.index, { pauseBefore: input.pauseBefore });
        yield* store.updateRun(run.id, { updatedAt: yield* nowIso });
        yield* notifyRunChanged(run.id);
      }),
    );
    return yield* result(input.runId);
  });

  const cancelForDeletedParent = (runId: PipelineRunId) =>
    cancelRun(runId, "The pipeline's parent thread was deleted.");

  const onThreadDeleted = (threadId: ThreadId) =>
    bestEffort(
      "Could not cancel pipeline run for deleted parent",
      Effect.gen(function* () {
        const run = yield* store.getRunByParentThreadId(threadId);
        if (run !== null) yield* cancelForDeletedParent(run.id);
      }),
    );

  const recoverRun = (runId: PipelineRunId) =>
    bestEffort(
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
          yield* ensureParent(run);
        }
        if (run.status === "running") yield* wake(runId);
      }),
    );

  /** Sweeps the runs that were live at startup, then watches for parent deletions. */
  const startRecovery = Effect.fn("PipelineRunner.startRecovery")(function* () {
    const liveRunIds = yield* store
      .listRunIdsByStatus(["running", "paused"])
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not list live pipeline runs", { error }).pipe(
            Effect.as([] as ReadonlyArray<PipelineRunId>),
          ),
        ),
      );
    yield* forkParked(
      Effect.forEach(liveRunIds, recoverRun, { discard: true }).pipe(
        Effect.andThen(
          Stream.runForEach(threads.streamDomainEvents, (event) =>
            event.type === "thread.deleted" ? onThreadDeleted(event.threadId) : Effect.void,
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Pipeline recovery stopped", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  });

  return {
    start,
    continueRun,
    retryStep,
    skipStep,
    cancel,
    setStepPauseBefore,
    startRecovery,
  };
});
