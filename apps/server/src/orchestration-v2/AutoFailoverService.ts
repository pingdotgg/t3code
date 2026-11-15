import {
  CommandId,
  isDelegatedAppThread,
  isProviderNativeSubagentThread,
  MessageId,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { routedAutoLevel } from "@t3tools/shared/autoModel";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { markAutoCooldown } from "./AutoCooldown.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** Failures that mean "this account has no room right now", besides the usage_limit class. */
const CAPACITY_CODES: ReadonlySet<string> = new Set([
  "UNAVAILABLE",
  "RESOURCE_EXHAUSTED",
  "api_error_529",
  "overloaded_error",
]);
/** A limit without a reported reset benches the instance this long. */
const LIMIT_COOLDOWN_MS = 30 * 60_000;
/** No capacity is usually short-lived. */
const CAPACITY_COOLDOWN_MS = 5 * 60_000;
/** A reported reset further out than this is treated as this. */
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
/** At most this many failovers per thread per hour, so a misreported limit cannot loop. */
export const MAX_FAILOVERS_PER_HOUR = 6;
/** The run's error item lands around the same time as the run update; let the shell catch up. */
const SETTLE_DELAY_MS = 1_500;

const AUTO_FAILOVER_TEXT =
  "Auto moved this thread to another subscription because the last one hit its usage limit. Continue where you left off.";

export interface AutoFailoverPlan {
  readonly failedInstanceId: string;
  readonly cooldownUntilMs: number;
  readonly command: Extract<
    Parameters<Orchestrator.OrchestratorV2Shape["dispatch"]>[0],
    { readonly type: "message.dispatch" }
  >;
}

/**
 * What to do when a run on an Auto thread fails: bench the instance that failed and send the
 * thread back through Auto, which then picks the next subscription in the chain. Null when the
 * run did not fail for lack of room, or the thread is a delegated one not on Auto, or the run is
 * no longer the thread's latest.
 */
export function autoFailoverPlan(input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly runId: RunId;
  readonly failedInstanceId: string;
  readonly nowMs: number;
}): AutoFailoverPlan | null {
  const { shell, runId, nowMs } = input;
  if (
    shell.latestRunId !== runId ||
    shell.status !== "failed" ||
    shell.archivedAt !== null ||
    shell.settledOverride === "settled" ||
    shell.pendingRuntimeRequest !== null ||
    // A provider's own subagent cannot receive messages; its parent sees the failure.
    isProviderNativeSubagentThread(shell)
  )
    return null;
  // A thread not on Auto (an older thread, or one where a model was picked by hand) moves to
  // Auto at the level its model implies: a limit there means the picked model is out anyway.
  // Delegated threads keep the model their parent chose; their parent sees the failure.
  const routed = routedAutoLevel(shell.modelSelection);
  if (routed === undefined && isDelegatedAppThread(shell)) return null;
  const level = routed ?? impliedAutoLevel(shell.modelSelection.model);
  const limited = shell.lastErrorClass === "usage_limit";
  const noCapacity = !limited && CAPACITY_CODES.has(shell.lastErrorCode ?? "");
  if (!limited && !noCapacity) return null;
  const resetMs = shell.usageLimitResetAt ? Date.parse(shell.usageLimitResetAt) : Number.NaN;
  const cooldownUntilMs = noCapacity
    ? nowMs + CAPACITY_COOLDOWN_MS
    : Number.isFinite(resetMs) && resetMs > nowMs
      ? Math.min(resetMs, nowMs + MAX_COOLDOWN_MS)
      : nowMs + LIMIT_COOLDOWN_MS;
  return {
    failedInstanceId: input.failedInstanceId,
    cooldownUntilMs,
    command: {
      type: "message.dispatch",
      // One failover per failed run, even across duplicate events.
      commandId: CommandId.make(`server:auto-failover:${shell.id}:${runId}`),
      messageId: MessageId.make(`auto-failover:${shell.id}:${runId}`),
      threadId: shell.id,
      // The Auto level row; routing replaces it with the next usable subscription.
      modelSelection: { instanceId: shell.modelSelection.instanceId, model: `auto-${level}` },
      text: AUTO_FAILOVER_TEXT,
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      dispatchMode: { type: "start_immediately" },
    },
  };
}

/** The Auto level whose orchestrator is closest to a hand-picked model. */
function impliedAutoLevel(model: string): "low" | "medium" | "high" {
  if (/fable|gpt-6\.1-sol|astra/i.test(model)) return "high";
  if (/sonnet|haiku|flash|opencode\/|luna/i.test(model)) return "low";
  return "medium";
}

/** Keeps the timestamps of recent failovers under the hourly cap; true when one more fits. */
export function admitFailover(history: Array<number>, nowMs: number): boolean {
  const recent = history.filter((at) => nowMs - at < 60 * 60_000);
  history.splice(0, history.length, ...recent);
  if (recent.length >= MAX_FAILOVERS_PER_HOUR) return false;
  history.push(nowMs);
  return true;
}

/**
 * Fork feature: when a run on an Auto thread fails because its subscription hit a usage limit
 * (or has no capacity), the thread moves on at once to the next subscription Auto picks, instead
 * of waiting hours for that account to reset.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const history = new Map<ThreadId, Array<number>>();

  const failOver = Effect.fn("AutoFailoverService.failOver")(
    function* (threadId: ThreadId, runId: RunId, failedInstanceId: string) {
      yield* Effect.sleep(Duration.millis(SETTLE_DELAY_MS));
      const shell = yield* orchestrator.getThreadShell(threadId);
      if (shell === null) return;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const plan = autoFailoverPlan({ shell, runId, failedInstanceId, nowMs });
      if (plan === null) return;
      // Bench the instance either way, so the next message the user sends routes around it.
      markAutoCooldown(plan.failedInstanceId, plan.cooldownUntilMs);
      // The same switch as resuming at reset: off means T3 sends nothing on its own.
      if (!(yield* settings.getSettings).autoResumeLimitedThreads) return;
      const threadHistory = history.get(threadId) ?? [];
      history.set(threadId, threadHistory);
      if (!admitFailover(threadHistory, nowMs)) {
        yield* Effect.logWarning("auto failover skipped: hourly cap reached", { threadId });
        return;
      }
      yield* Effect.logInfo("auto failover", {
        threadId,
        runId,
        failedInstanceId,
        errorClass: shell.lastErrorClass,
        errorCode: shell.lastErrorCode,
        cooldownUntil: DateTime.formatIso(DateTime.makeUnsafe(plan.cooldownUntilMs)),
      });
      yield* orchestrator.dispatch(plan.command);
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          // No usable subscription left: the usage-limit recovery worker still resumes at reset.
          Effect.logWarning("auto failover did not dispatch", { threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("AutoFailoverService.start")(function* () {
    const pending = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "failed"
          ? FiberMap.run(
              pending,
              event.threadId,
              failOver(event.threadId, event.payload.id, event.payload.providerInstanceId),
            )
          : Effect.void,
      ),
    );
  });
  return { start };
});
