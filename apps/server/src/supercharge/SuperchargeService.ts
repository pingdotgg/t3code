// @effect-diagnostics effectFnOpportunity:off globalDate:off globalDateInEffect:off globalJsonInEffect:off runEffectInsideEffect:off nodeBuiltinImport:off - Thin wrapper over promise-based cores; spans come from withSpan, and wall-clock timestamps are user-facing state.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_SUPERCHARGE_CONFIG,
  MessageId,
  SUPERCHARGE_DEFAULT_LIMITS,
  SuperchargeError,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ServerProvider,
  type SuperchargeConfig,
  type SuperchargePhase,
  type SuperchargeRun,
  type SuperchargeStopReason,
  type SuperchargeThreadState,
  type ThreadId,
} from "@t3tools/contracts";
import {
  decideNextSupercharge,
  estimateTokens,
  parseSuperchargeReport,
  strongestEffort,
  superchargeTurnContext,
  type SuperchargeTurnOutcome,
} from "@t3tools/shared/superchargeWorkflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

/**
 * Supercharge state: each thread's preset and limits, and the run in progress. Turn start reads
 * it to add Supercharge's instructions; `runnerLayer` watches each supercharged run end and decides
 * whether Continuum starts another turn.
 */

interface ActiveRun {
  run: SuperchargeRun;
  readonly runIds: Set<string>;
  readonly projectId: string | null;
}

export class SuperchargeService extends Context.Service<
  SuperchargeService,
  {
    readonly get: (threadId: ThreadId) => Effect.Effect<SuperchargeThreadState>;
    readonly configure: (threadId: ThreadId, config: SuperchargeConfig) => Effect.Effect<SuperchargeThreadState, SuperchargeError>;
    /** Instructions for this turn, or "" when Supercharge is off. Registers the run for watching. */
    readonly contextForTurn: (input: { readonly threadId: ThreadId; readonly runId: RunId }) => Effect.Effect<string>;
    readonly markStopped: (threadId: ThreadId, reason: SuperchargeStopReason, message: string) => Effect.Effect<SuperchargeThreadState>;
    /** Runs whose end the runner should judge. */
    readonly started: Queue.Dequeue<{ readonly threadId: ThreadId; readonly runId: RunId }>;
    readonly active: (threadId: ThreadId) => ActiveRun | null;
    readonly recordFollowUp: (threadId: ThreadId, runId: string, phase: SuperchargePhase, summary: string, effort: string | null) => Effect.Effect<void>;
    readonly recordProgress: (threadId: ThreadId, update: (run: SuperchargeRun) => SuperchargeRun) => Effect.Effect<void>;
    readonly config: (threadId: ThreadId) => SuperchargeConfig;
  }
>()("t3/supercharge/SuperchargeService") {}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const file = NodePath.join(serverConfig.stateDir, "supercharge.json");
  const configs = new Map<string, SuperchargeConfig>();
  const lastRuns = new Map<string, SuperchargeRun>();
  const active = new Map<string, ActiveRun>();
  /** Runs Continuum itself started, so turn start continues the run instead of restarting it. */
  const followUps = new Set<string>();
  const started = yield* Queue.unbounded<{ readonly threadId: ThreadId; readonly runId: RunId }>();

  yield* Effect.promise(async () => {
    try {
      const stored = JSON.parse(await NodeFSP.readFile(file, "utf8")) as { threads?: Record<string, { config: SuperchargeConfig; lastRun?: SuperchargeRun }> };
      for (const [threadId, entry] of Object.entries(stored.threads ?? {})) {
        configs.set(threadId, { ...DEFAULT_SUPERCHARGE_CONFIG, ...entry.config });
        if (entry.lastRun) lastRuns.set(threadId, entry.lastRun);
      }
    } catch {
      // First start, or an unreadable file: every thread starts with Supercharge off.
    }
  });

  const persist = Effect.promise(async () => {
    const threads: Record<string, unknown> = {};
    for (const [threadId, config] of configs) threads[threadId] = { config, lastRun: active.get(threadId)?.run ?? lastRuns.get(threadId) };
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    const temporary = `${file}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
    await NodeFSP.writeFile(temporary, JSON.stringify({ version: 1, threads }, null, 2));
    await NodeFSP.rename(temporary, file);
  });

  const configOf = (threadId: string) => configs.get(threadId) ?? DEFAULT_SUPERCHARGE_CONFIG;
  const stateOf = (threadId: ThreadId): SuperchargeThreadState => ({
    threadId,
    config: configOf(threadId),
    run: active.get(threadId)?.run ?? lastRuns.get(threadId) ?? null,
  });

  const finish = (threadId: string, reason: SuperchargeStopReason, message: string) => {
    const entry = active.get(threadId);
    if (!entry) return;
    const at = new Date().toISOString();
    const run: SuperchargeRun = {
      ...entry.run,
      phase: "finished",
      stop: { reason, message, at },
      log: [...entry.run.log, { at, iteration: entry.run.iteration, phase: "finished", summary: message }],
    };
    active.delete(threadId);
    lastRuns.set(threadId, run);
  };

  return SuperchargeService.of({
    started,
    config: configOf,
    active: (threadId) => active.get(threadId) ?? null,
    get: (threadId) => Effect.sync(() => stateOf(threadId)),
    configure: (threadId, config) =>
      Effect.gen(function* () {
        if (config.preset === "deep" && config.independentReview && config.limits.maxIterations < 2) {
          return yield* new SuperchargeError({ message: "Deep with an independent review needs at least 2 follow-up turns." });
        }
        configs.set(threadId, config);
        const entry = active.get(threadId);
        if (entry && config.preset === "off") finish(threadId, "stopped-by-user", "Supercharge was turned off.");
        else if (entry && config.preset !== "off") {
          // New limits apply to the run in progress; the deadline counts from its start.
          entry.run = {
            ...entry.run,
            limits: config.limits,
            deadlineAt: new Date(Date.parse(entry.run.startedAt) + config.limits.maxMinutes * 60_000).toISOString(),
          };
        }
        yield* persist;
        return stateOf(threadId);
      }).pipe(Effect.withSpan("SuperchargeService.configure")),
    contextForTurn: ({ threadId, runId }) =>
      Effect.gen(function* () {
        const config = configOf(threadId);
        if (config.preset === "off") return "";
        const entry = active.get(threadId);
        if (followUps.has(runId) && entry) {
          return superchargeTurnContext({ preset: entry.run.preset, phase: entry.run.phase, iteration: entry.run.iteration, limits: entry.run.limits });
        }
        if (entry?.runIds.has(runId)) {
          // A retried attempt of a run already being watched.
          return superchargeTurnContext({ preset: entry.run.preset, phase: entry.run.phase, iteration: entry.run.iteration, limits: entry.run.limits });
        }
        if (entry) finish(threadId, "stopped-by-user", "A new message started a new Supercharge run.");
        const now = new Date();
        const run: SuperchargeRun = {
          preset: config.preset,
          phase: "implementing",
          iteration: 0,
          limits: config.limits,
          startedAt: now.toISOString(),
          deadlineAt: new Date(now.getTime() + config.limits.maxMinutes * 60_000).toISOString(),
          tokensUsed: null,
          tokensMeasured: false,
          checks: [],
          testsRun: [],
          effort: null,
          stop: null,
          log: [{ at: now.toISOString(), iteration: 0, phase: "implementing", summary: "Started: define checks, implement, inspect the diff, verify." }],
        };
        active.set(threadId, { run, runIds: new Set([runId]), projectId: null });
        yield* Queue.offer(started, { threadId, runId });
        yield* persist;
        return superchargeTurnContext({ preset: config.preset, phase: "implementing", iteration: 0, limits: config.limits });
      }),
    markStopped: (threadId, reason, message) =>
      Effect.gen(function* () {
        finish(threadId, reason, message);
        yield* persist;
        return stateOf(threadId);
      }),
    recordFollowUp: (threadId, runId, phase, summary, effort) =>
      Effect.gen(function* () {
        const entry = active.get(threadId);
        if (!entry) return;
        followUps.add(runId);
        entry.runIds.add(runId);
        const iteration = entry.run.iteration + 1;
        entry.run = {
          ...entry.run,
          iteration,
          phase,
          effort: effort ?? entry.run.effort,
          log: [...entry.run.log, { at: new Date().toISOString(), iteration, phase, summary }],
        };
        yield* Queue.offer(started, { threadId, runId: runId as RunId });
        yield* persist;
      }),
    recordProgress: (threadId, update) =>
      Effect.gen(function* () {
        const entry = active.get(threadId);
        if (!entry) return;
        entry.run = update(entry.run);
        yield* persist;
      }),
  });
});

export const layer = Layer.effect(SuperchargeService, make);

// Runner ---------------------------------------------------------------------------------------

function outcomeOf(status: string | undefined): SuperchargeTurnOutcome {
  if (status === "completed") return "completed";
  if (status === "interrupted" || status === "cancelled" || status === "rolled_back") return "interrupted";
  return "failed";
}

/** Tokens the provider reported for these runs; an estimate from text when none reported. */
export function runUsage(projection: Pick<OrchestrationV2ThreadProjection, "attempts" | "providerTurns" | "messages">, runIds: ReadonlySet<string>) {
  const attemptIds = new Set(projection.attempts.filter((attempt) => runIds.has(attempt.runId)).map((attempt) => attempt.id));
  let measured = 0;
  let any = false;
  for (const turn of projection.providerTurns) {
    if (turn.runAttemptId === null || !attemptIds.has(turn.runAttemptId)) continue;
    const usage = turn.turnTokenUsage;
    if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
      measured += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      any = true;
    }
  }
  if (any) return { tokens: measured, measured: true };
  const text = projection.messages.filter((message) => message.runId !== null && runIds.has(message.runId)).map((message) => message.text).join("\n");
  return { tokens: estimateTokens(text), measured: false };
}

function boostedSelection(selection: ModelSelection, providers: ReadonlyArray<ServerProvider>): { readonly selection: ModelSelection; readonly effort: string | null } {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (option) => option.type === "select" && (option.role === "reasoning" || /effort|reasoning|thinking/i.test(option.id)),
  );
  if (!descriptor || descriptor.type !== "select") return { selection, effort: null };
  const effort = strongestEffort(descriptor.options.map((choice) => choice.id));
  if (effort === null) return { selection, effort: null };
  const others = (Array.isArray(selection.options) ? selection.options : []).filter((option) => option.id !== descriptor.id);
  return { selection: { ...selection, options: [...others, { id: descriptor.id, value: effort }] }, effort };
}

const watchRun = Effect.fn("SuperchargeRunner.watchRun")(function* (threadId: ThreadId, runId: RunId) {
  const supercharge = yield* SuperchargeService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const shell = yield* threads.getThreadShell(threadId);
  if (shell === null) return;
  const entry = supercharge.active(threadId);
  if (!entry) return;
  const remaining = Math.max(Date.parse(entry.run.deadlineAt) - Date.now(), 1_000);
  const waited = yield* threads.waitForThread({ projectId: shell.projectId, threadId, runId, timeoutMs: remaining });
  if (supercharge.active(threadId)?.run !== entry.run && supercharge.active(threadId) === null) return;
  if (waited.timedOut) {
    yield* threads
      .interruptThread({ projectId: shell.projectId, commandId: CommandId.make(`supercharge:timeout:${runId}`), threadId, runId, reason: "Supercharge time limit" })
      .pipe(Effect.ignore);
    yield* supercharge.markStopped(threadId, "time-limit", `The ${entry.run.limits.maxMinutes}-minute limit ran out, so the turn was stopped.`);
    return;
  }
  const current = supercharge.active(threadId);
  if (!current) return;
  const { projection } = yield* threads.getThreadSnapshotWindow(threadId, { rowLimit: 200 });
  const reply = projection.messages
    .filter((message) => message.role === "assistant" && message.runId === runId)
    .map((message) => message.text)
    .join("\n\n");
  const report = parseSuperchargeReport(reply);
  const usage = runUsage(projection, current.runIds);
  yield* supercharge.recordProgress(threadId, (run) => ({
    ...run,
    tokensUsed: usage.tokens,
    tokensMeasured: usage.measured,
    checks: report?.checks ?? run.checks,
    testsRun: report ? [...new Set([...run.testsRun, ...report.testsRun])] : run.testsRun,
  }));
  const run = supercharge.active(threadId)!.run;
  const decision = decideNextSupercharge({
    run,
    report,
    outcome: outcomeOf(waited.run?.status),
    nowMs: Date.now(),
    independentReview: supercharge.config(threadId).independentReview,
  });
  if (decision.type === "stop") {
    yield* supercharge.markStopped(threadId, decision.reason, decision.message);
    return;
  }
  const deep = run.preset === "deep" ? boostedSelection(shell.modelSelection, yield* providers.getProviders) : null;
  const sent = yield* threads.sendToThread({
    projectId: shell.projectId,
    commandId: CommandId.make(`supercharge:${threadId}:${run.iteration + 1}:${runId}`),
    threadId,
    messageId: MessageId.make(`supercharge:${runId}:${run.iteration + 1}`),
    text: decision.prompt,
    attachments: [],
    mode: "queue",
    ...(decision.freshContext ? { freshContext: true } : {}),
    // Deep raises reasoning effort on the user's own model; it never switches models.
    ...(deep && deep.effort !== null ? { modelSelection: deep.selection } : {}),
    createdBy: "system",
    creationSource: "server",
  });
  yield* supercharge.recordFollowUp(threadId, sent.run.id, decision.phase, decision.prompt.split("\n").slice(2).join(" ").slice(0, 240), deep?.effort ?? null);
});

/** Watches each supercharged run to its end; forked for the server's lifetime. */
export const runnerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const supercharge = yield* SuperchargeService;
    yield* Queue.take(supercharge.started).pipe(
      Effect.flatMap(({ threadId, runId }) =>
        watchRun(threadId, runId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Supercharge stopped after an error", cause).pipe(
              Effect.andThen(supercharge.markStopped(threadId, "turn-failed", "Supercharge hit an internal error and stopped.")),
            ),
          ),
          Effect.forkDetach,
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);

export const presetLimits = SUPERCHARGE_DEFAULT_LIMITS;

/** The Stop button: no further Supercharge turns, and the running turn is interrupted. */
export const stopThread = Effect.fn("SuperchargeService.stopThread")(function* (threadId: ThreadId) {
  const supercharge = yield* SuperchargeService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const wasActive = supercharge.active(threadId) !== null;
  const state = yield* supercharge.markStopped(threadId, "stopped-by-user", "You stopped Supercharge.");
  if (wasActive) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell !== null) {
      yield* threads
        .interruptThread({ projectId: shell.projectId, commandId: CommandId.make(`supercharge:stop:${threadId}:${Date.now()}`), threadId, reason: "Supercharge stopped" })
        .pipe(Effect.ignore);
    }
  }
  return state;
});
