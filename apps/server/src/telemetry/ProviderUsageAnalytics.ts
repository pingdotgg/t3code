/**
 * Provider token reporting: one `provider.turn.completed` per provider turn and one
 * `provider.request.completed` per run, built from the same turns so each counts once.
 *
 * @module ProviderUsageAnalytics
 */
import type {
  ModelSelection,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RunAttempt,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  TurnTokenUsage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { catalogModelLabel } from "./ProviderDimensions.ts";

// Bump when a field changes meaning, so reports can split old and new rows.
const REPORT_VERSION = 2;

/**
 * Where the run's starting message came from. Most turns start without a
 * person (provider continuations, agent sends, delegated subagents), so
 * reports need this to tell user turns apart.
 */
export interface ProviderTurnOrigin {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduled: boolean;
  readonly subagent: boolean;
}

/** What started this provider turn inside its run. */
export type ProviderTurnSegment =
  | OrchestrationV2RunAttempt["reason"]
  | "continuation"
  | "native_child";

export interface ProviderTurnAnalyticsContext {
  readonly runId?: RunId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly origin?: ProviderTurnOrigin;
  readonly segment?: ProviderTurnSegment;
  readonly restartContinuation?: boolean;
}

export interface ProviderTurnReport {
  readonly driver: string;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly context?: ProviderTurnAnalyticsContext;
}

export interface RunSettledReport {
  readonly runId: RunId;
  readonly status: OrchestrationV2ProviderTurn["status"];
  readonly completedAt: DateTime.Utc;
  // Run-owned children were still open when the run settled; their later turns are not added.
  readonly childrenRunning: boolean;
}

type Properties = Readonly<Record<string, unknown>>;
/** Maps a native model id to a vendor catalog label, or undefined to keep it out. */
export type ModelLabeler = (model: string) => string | undefined;

const TERMINAL_STATUSES: ReadonlySet<OrchestrationV2ProviderTurn["status"]> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

const REPORTED_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
  "ultracode",
  "brutal",
]);

const defined = (entries: Properties): Properties =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

// OpenCode names its effort option `variant`, and variants can be user-defined.
function selectedEffort(selection: ModelSelection): string | undefined {
  const effort =
    getModelSelectionStringOptionValue(selection, "reasoningEffort") ??
    getModelSelectionStringOptionValue(selection, "effort") ??
    getModelSelectionStringOptionValue(selection, "variant");
  return effort !== undefined && REPORTED_EFFORTS.has(effort) ? effort : undefined;
}

/**
 * Confirmed models across counted work. Unknown when any piece of work has no
 * reported model, unless two distinct models were already seen.
 */
function modelObservation(
  models: ReadonlyArray<ReadonlyArray<string> | undefined>,
  label: ModelLabeler,
): Properties {
  const distinct = new Set(models.flatMap((entry) => entry ?? []));
  if (distinct.size > 1) return { mixedModels: true };
  if (distinct.size === 0 || models.some((entry) => entry === undefined || entry.length === 0)) {
    return {};
  }
  return defined({ mixedModels: false, observedModel: label([...distinct][0]!) });
}

function selectionProperties(
  context: ProviderTurnAnalyticsContext | undefined,
  label: ModelLabeler,
) {
  const selection = context?.modelSelection;
  return defined({
    model: selection === undefined ? undefined : label(selection.model),
    effort: selection === undefined ? undefined : selectedEffort(selection),
    runtimeMode: context?.runtimeMode,
    interactionMode: context?.interactionMode,
    ...context?.origin,
  });
}

function childKind(context: ProviderTurnAnalyticsContext | undefined) {
  if (context?.segment === "native_child") return "native";
  return context?.origin?.subagent === true ? "t3" : undefined;
}

function counters(usage: TurnTokenUsage | undefined): Properties {
  return defined({
    inputTokens: usage?.inputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    cacheCreationTokens: usage?.cacheCreationTokens,
    outputTokens: usage?.outputTokens,
    reasoningTokens: usage?.reasoningTokens,
  });
}

export function providerTurnProperties(
  report: ProviderTurnReport,
  label: ModelLabeler,
): Properties {
  const { providerTurn, context } = report;
  const usage = providerTurn.turnTokenUsage;
  return defined({
    reportVersion: REPORT_VERSION,
    provider: report.driver,
    terminalStatus: providerTurn.status,
    usageStatus: usage?.usageStatus ?? "unavailable",
    usageScope: usage?.usageScope ?? "main_agent",
    usageReported: usage !== undefined,
    hasSubagents: usage?.hasSubagents,
    ...counters(usage),
    localCommand: usage?.localCommand === true ? true : undefined,
    otherInputTokens: usage?.otherUsage?.inputTokens,
    otherOutputTokens: usage?.otherUsage?.outputTokens,
    ...selectionProperties(context, label),
    ...modelObservation([usage?.models], label),
    segment: context?.segment,
    childKind: childKind(context),
    durationMs:
      providerTurn.startedAt && providerTurn.completedAt
        ? Math.max(
            0,
            DateTime.toEpochMillis(providerTurn.completedAt) -
              DateTime.toEpochMillis(providerTurn.startedAt),
          )
        : undefined,
  });
}

/** How the request reached the provider; only `user` counts as a person asking. */
function requestKind(origin: ProviderTurnOrigin | undefined) {
  if (origin === undefined) return "unknown";
  if (origin.scheduled) return "scheduled";
  if (origin.subagent) return "t3_child";
  if (origin.createdBy === "user") return "user";
  if (origin.creationSource === "provider") return "provider_continuation";
  return origin.createdBy;
}

function sumOf(
  usages: ReadonlyArray<TurnTokenUsage>,
  field:
    | "inputTokens"
    | "cachedInputTokens"
    | "cacheCreationTokens"
    | "outputTokens"
    | "reasoningTokens",
  requireAll: boolean,
): number | undefined {
  const values = usages.map((usage) => usage[field]);
  const known = values.filter((value) => value !== undefined);
  if (known.length === 0 || (requireAll && known.length < values.length)) return undefined;
  return known.reduce((sum, value) => sum + value, 0);
}

/** complete only when every turn is complete; partial when any turn has counts. */
function combinedStatus(usages: ReadonlyArray<TurnTokenUsage | undefined>) {
  if (usages.length > 0 && usages.every((usage) => usage?.usageStatus === "complete")) {
    return "complete";
  }
  return usages.some(
    (usage) => usage?.inputTokens !== undefined || usage?.outputTokens !== undefined,
  )
    ? "partial"
    : "unavailable";
}

interface RequestTurn {
  readonly child: boolean;
  readonly segment: ProviderTurnSegment | undefined;
  readonly providerTurn: OrchestrationV2ProviderTurn;
}

interface RequestEntry {
  driver: string | undefined;
  context: ProviderTurnAnalyticsContext | undefined;
  readonly lifecycleObserved: boolean;
  readonly turns: Map<string, RequestTurn>;
}

const MAX_TRACKED_RUNS = 2048;

/**
 * Collects terminal provider turns per run in this process. A replayed turn
 * replaces its earlier copy, a settled run ignores late turns, and a run whose
 * initial attempt started before this process reports `lifecycleObserved: false`.
 */
export class RequestUsageLedger {
  private readonly open = new Map<RunId, RequestEntry>();
  private readonly settled = new Set<RunId>();

  start(runId: RunId, driver: string, context: ProviderTurnAnalyticsContext): void {
    if (this.settled.has(runId) || this.open.has(runId)) return;
    // A restart continuation carries on a run whose earlier turns this process never saw.
    const lifecycleObserved = context.restartContinuation !== true;
    this.open.set(runId, { driver, context, lifecycleObserved, turns: new Map() });
    evictOldest(this.open);
  }

  add(report: ProviderTurnReport): void {
    const runId = report.context?.runId;
    if (runId === undefined || this.settled.has(runId)) return;
    if (!TERMINAL_STATUSES.has(report.providerTurn.status)) return;
    let entry = this.open.get(runId);
    if (entry === undefined) {
      entry = { driver: undefined, context: undefined, lifecycleObserved: false, turns: new Map() };
      this.open.set(runId, entry);
      evictOldest(this.open);
    }
    const child = report.context?.segment === "native_child";
    if (!child) {
      entry.driver ??= report.driver;
      entry.context ??= report.context;
    }
    entry.turns.set(String(report.providerTurn.id), {
      child,
      segment: report.context?.segment,
      providerTurn: report.providerTurn,
    });
  }

  settle(report: RunSettledReport, label: ModelLabeler): Properties | undefined {
    if (this.settled.has(report.runId)) return undefined;
    this.settled.add(report.runId);
    evictOldest(this.settled);
    const entry = this.open.get(report.runId);
    this.open.delete(report.runId);
    if (entry === undefined) return undefined;

    const turns = [...entry.turns.values()];
    const root = turns.filter((turn) => !turn.child);
    const children = turns.filter((turn) => turn.child);
    const rootUsage = root.map((turn) => turn.providerTurn.turnTokenUsage);
    const childUsage = children.map((turn) => turn.providerTurn.turnTokenUsage);
    const { lifecycleObserved } = entry;
    const measuredRoot = rootUsage.filter((usage) => usage !== undefined);
    const status = combinedStatus(rootUsage);
    const rootComplete = status === "complete";
    const otherUsage = measuredRoot.map((usage) => usage.otherUsage);
    const allOtherKnown = otherUsage.length > 0 && otherUsage.every((usage) => usage !== undefined);
    const anyRootSubagents = measuredRoot.some((usage) => usage.hasSubagents);
    const measuredChildren = childUsage.filter((usage) => usage !== undefined);
    const childStatus =
      children.length === 0 && !anyRootSubagents && !report.childrenRunning
        ? "none"
        : children.length === 0
          ? "unavailable"
          : report.childrenRunning && combinedStatus(childUsage) === "complete"
            ? "partial"
            : combinedStatus(childUsage);
    const startedAt = turns
      .map((turn) => turn.providerTurn.startedAt)
      .filter((value) => value !== null)
      .map(DateTime.toEpochMillis);

    return defined({
      reportVersion: REPORT_VERSION,
      provider: entry.driver ?? "unknown",
      requestKind: requestKind(entry.context?.origin),
      restartContinuation: entry.context?.restartContinuation === true ? true : undefined,
      terminalStatus: report.status,
      lifecycleObserved,
      ...selectionProperties(entry.context, label),
      providerTurns: root.length,
      continuations: root.filter((turn) => turn.segment === "continuation").length,
      steeringRestarts: root.filter((turn) => turn.segment === "steering_restart").length,
      usageStatus: lifecycleObserved || status === "unavailable" ? status : "partial",
      inputTokens: sumOf(measuredRoot, "inputTokens", rootComplete),
      cachedInputTokens: sumOf(measuredRoot, "cachedInputTokens", true),
      cacheCreationTokens: sumOf(measuredRoot, "cacheCreationTokens", true),
      outputTokens: sumOf(measuredRoot, "outputTokens", rootComplete),
      reasoningTokens: sumOf(measuredRoot, "reasoningTokens", true),
      localCommand: measuredRoot.some((usage) => usage.localCommand === true) ? true : undefined,
      otherInputTokens: allOtherKnown
        ? otherUsage.reduce((sum, usage) => sum + (usage?.inputTokens ?? 0), 0)
        : undefined,
      otherOutputTokens: allOtherKnown
        ? otherUsage.reduce((sum, usage) => sum + (usage?.outputTokens ?? 0), 0)
        : undefined,
      nativeChildTurns: children.length,
      childUsageStatus: childStatus,
      childInputTokens: sumOf(measuredChildren, "inputTokens", false),
      childOutputTokens: sumOf(measuredChildren, "outputTokens", false),
      childrenRunning: report.childrenRunning ? true : undefined,
      ...modelObservation(
        [...rootUsage, ...childUsage].map((usage) => usage?.models),
        label,
      ),
      durationMs:
        startedAt.length === 0
          ? undefined
          : Math.max(0, DateTime.toEpochMillis(report.completedAt) - Math.min(...startedAt)),
    });
  }
}

function evictOldest(collection: Map<RunId, unknown> | Set<RunId>) {
  if (collection.size <= MAX_TRACKED_RUNS) return;
  const oldest = collection.keys().next().value;
  if (oldest !== undefined) collection.delete(oldest);
}

export class ProviderTurnAnalytics extends Context.Reference<{
  readonly runStarted: (input: {
    readonly runId: RunId;
    readonly driver: string;
    readonly context: ProviderTurnAnalyticsContext;
  }) => Effect.Effect<void>;
  readonly turnCompleted: (report: ProviderTurnReport) => Effect.Effect<void>;
  readonly runSettled: (report: RunSettledReport) => Effect.Effect<void>;
}>("t3/telemetry/ProviderTurnAnalytics", {
  defaultValue: () => ({
    runStarted: () => Effect.void,
    turnCompleted: () => Effect.void,
    runSettled: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ProviderTurnAnalytics,
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const ledger = new RequestUsageLedger();
    const labeler = Effect.map(
      registry.getProviders,
      (providers): ModelLabeler =>
        (model) =>
          catalogModelLabel(providers, model),
    );
    return {
      runStarted: Effect.fn("ProviderTurnAnalytics.runStarted")((input) =>
        Effect.sync(() => ledger.start(input.runId, input.driver, input.context)),
      ),
      turnCompleted: Effect.fn("ProviderTurnAnalytics.turnCompleted")(function* (report) {
        ledger.add(report);
        yield* analytics.record(
          "provider.turn.completed",
          providerTurnProperties(report, yield* labeler),
        );
      }),
      runSettled: Effect.fn("ProviderTurnAnalytics.runSettled")(function* (report) {
        const properties = ledger.settle(report, yield* labeler);
        if (properties !== undefined) {
          yield* analytics.record("provider.request.completed", properties);
        }
      }),
    };
  }),
);
