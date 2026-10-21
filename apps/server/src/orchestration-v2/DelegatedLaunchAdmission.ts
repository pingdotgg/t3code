import {
  CommandId,
  DelegatedQuotaScope,
  resolveProjectProviderInstanceEnabled,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type {
  DelegatedLaunchBinding,
  ModelSelection,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerSettingsError,
  ThreadId,
  RunId,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { DelegatedLaunchPoolPrepareOutcome } from "@t3tools/provider-core/server/driver";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  classifyPoolRefusal,
  launchAttemptKey,
  type LaunchRefusalScope,
} from "../provider/CodexPoolControl.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

export class DelegatedLaunchAdmissionError extends Schema.TaggedError<DelegatedLaunchAdmissionError>()(
  "DelegatedLaunchAdmissionError",
  { cause: Schema.Defect() },
) {}
const isDelegatedLaunchAdmissionError = Schema.is(DelegatedLaunchAdmissionError);

export class WaitingForDelegatedCapacity extends Schema.TaggedError<WaitingForDelegatedCapacity>()(
  "WaitingForDelegatedCapacity",
  { retryAt: Schema.String },
) {}

const isWaitingForDelegatedCapacity = Schema.is(WaitingForDelegatedCapacity);

// Inspect typed causes only; provider messages must never control retry policy.
export function capacityWaitCause(
  error: unknown,
  depth = 0,
): WaitingForDelegatedCapacity | undefined {
  if (depth > 8) return undefined;
  if (isWaitingForDelegatedCapacity(error)) return error;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return capacityWaitCause(error.cause, depth + 1);
  }
  return undefined;
}

export function isLaunchQuotaFailure(error: unknown, depth = 0): boolean {
  if (depth > 8 || typeof error !== "object" || error === null) return false;
  if ("class" in error && error.class === "usage_limit") return true;
  if (
    "code" in error &&
    typeof error.code === "string" &&
    [
      "usage_limit",
      "quota_exceeded",
      "insufficient_quota",
      "rate_limit_exceeded",
      "delegated_capacity_unverified",
    ].includes(error.code)
  )
    return true;
  return (
    ("failure" in error && isLaunchQuotaFailure(error.failure, depth + 1)) ||
    ("cause" in error && isLaunchQuotaFailure(error.cause, depth + 1))
  );
}

const isDelegatedQuotaScope = Schema.is(DelegatedQuotaScope);

export function launchQuotaScope(error: unknown, depth = 0): DelegatedQuotaScope {
  if (depth > 8 || typeof error !== "object" || error === null) return { type: "account" };
  if ("quotaScope" in error && isDelegatedQuotaScope(error.quotaScope)) return error.quotaScope;
  if ("failure" in error) return launchQuotaScope(error.failure, depth + 1);
  if ("cause" in error) return launchQuotaScope(error.cause, depth + 1);
  return { type: "account" };
}

// Throttling or model capacity says nothing about the account's quota: skip only
// this candidate until the race block expires.
export const launchCandidateKey = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  `launch:candidate:${selection.instanceId}:${selection.model}`;

export function refusedQuotaDomains(
  domains: ReadonlyArray<string>,
  scope: DelegatedQuotaScope,
): ReadonlyArray<string> {
  const accounts = [...new Set(domains.map((key) => key.split(":quota:")[0]!))];
  if (scope.type === "account") return accounts;
  const scoped = accounts.map((key) => `${key}:quota:${scope.windowId}`);
  // Only a window observed at admission establishes a narrower bucket.
  return scoped.some((key) => domains.includes(key)) ? scoped : accounts;
}

export type AdmissionDecision =
  | {
      readonly status: "ready";
      readonly selection: ModelSelection;
      readonly domains: ReadonlyArray<string>;
      readonly binding?: DelegatedLaunchBinding;
    }
  | {
      readonly status: "waiting";
      readonly reason: "exhausted" | "throttled" | "unverified";
      readonly retryAt: string;
    };

type Assessment = "healthy" | "exhausted" | "unverified";

export function assessCapacity(
  limits: ServerProviderUsageLimits | undefined,
  driver: string,
  model: string,
  probeStartedAt: number,
  now: number,
): Assessment {
  if (
    !limits ||
    limits.unavailable ||
    !Number.isFinite(Date.parse(limits.checkedAt)) ||
    Date.parse(limits.checkedAt) < probeStartedAt ||
    Date.parse(limits.checkedAt) > now ||
    now - Date.parse(limits.checkedAt) > 30_000
  )
    return "unverified";
  // Only these adapters bind their local read-only probe to the same configured
  // runtime as openSession. A proxy/pool needs its own binding contract first.
  if (driver === "codex" && model.toLowerCase().includes("spark")) return "unverified";
  if (
    driver === "claudeAgent" &&
    !["opus", "sonnet", "haiku"].some((family) => model.toLowerCase().includes(family))
  )
    return "unverified";
  const required =
    driver === "codex"
      ? limits.ordinaryUsageAllowed !== undefined
        ? []
        : ["primary", "secondary"]
      : driver === "claudeAgent"
        ? ["five_hour", "seven_day"]
        : driver === "opencode" &&
            (model.startsWith("kimi-for-coding/") || model.startsWith("kimi-code-plan-global/"))
          ? ["limit_5h", "limit_month_total", "limit_month_code"]
          : driver === "opencode" && model.startsWith("opencode-go/")
            ? ["go_rolling", "go_weekly", "go_monthly"]
            : driver === "cursor"
              ? ["totalPercentUsed", model === "auto" ? "autoPercentUsed" : "apiPercentUsed"]
              : driver === "grok"
                ? ["subscription"]
                : undefined;
  if (
    !required ||
    (driver === "codex" &&
      !limits.windows.some((w) => w.id === "primary" || w.id === "secondary")) ||
    required.some((id) => !limits.windows.some((w) => w.id === id))
  )
    return "unverified";
  const relevant = limits.windows.filter((window) => {
    if (driver === "cursor") return required.includes(window.id);
    if (!window.id.startsWith("seven_day_")) return true;
    const family = ["opus", "sonnet", "haiku"].find((name) => window.id.includes(name));
    return family === undefined || model.toLowerCase().includes(family);
  });
  if (
    relevant.some(
      (w) => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100,
    )
  )
    return "unverified";
  return limits.ordinaryUsageAllowed === false || relevant.some((w) => w.usedPercent >= 100)
    ? "exhausted"
    : "healthy";
}

function supportedOptions(provider: ServerProvider, candidate: ModelSelection) {
  const model = provider.models.find((m) => m.slug === candidate.model);
  return candidate.options?.filter((option) =>
    model?.capabilities?.optionDescriptors?.some(
      (d) =>
        d.id === option.id &&
        (d.type === "boolean"
          ? typeof option.value === "boolean"
          : d.options.some((choice) => choice.id === option.value)),
    ),
  );
}

export const selectLaunchCandidate = Effect.fn("DelegatedLaunchAdmission.selectCandidate")(
  function* (input: {
    readonly candidates: ReadonlyArray<ModelSelection>;
    readonly blockedDomains?: ReadonlyArray<string>;
    /** Pool control may wait on the launcher's credential helper (two 40 s calls). */
    readonly probeTimeout?: Duration.Input;
    readonly probe: (
      selection: ModelSelection,
      blocked: ReadonlySet<string>,
    ) => Effect.Effect<
      | {
          readonly provider: ServerProvider;
          readonly binding?: string;
          readonly probeStartedAt: number;
          /** A launcher-owned binding replaces local usage evidence entirely. */
          readonly pool?: DelegatedLaunchPoolPrepareOutcome;
        }
      | undefined
    >;
  }) {
    const blocked = new Set<string>(input.blockedDomains);
    let exhausted = false;
    let throttled = [...blocked].some((key) => key.startsWith("launch:attempt:"));
    for (const candidate of input.candidates) {
      if (blocked.has(launchCandidateKey(candidate))) {
        throttled = true;
        continue;
      }
      const observed = yield* input.probe(candidate, blocked).pipe(
        Effect.timeout(input.probeTimeout ?? "8 seconds"),
        Effect.orElseSucceed(() => undefined),
      );
      if (!observed) continue;
      if (observed.pool) {
        const outcome = observed.pool;
        if (outcome.status === "waiting") {
          for (const key of outcome.quotaDomains) blocked.add(key);
          exhausted = true;
          continue;
        }
        if (outcome.status === "unverified") continue;
        const domains = outcome.binding.result.quotaDomains;
        if (domains.some((key) => blocked.has(launchAttemptKey(key)))) {
          throttled = true;
          continue;
        }
        if (domains.some((key) => blocked.has(key))) {
          exhausted = true;
          continue;
        }
        const options = supportedOptions(observed.provider, candidate);
        return {
          status: "ready",
          selection: { ...candidate, ...(options ? { options } : {}) },
          domains,
          binding: outcome.binding,
        } as const;
      }
      const { binding, probeStartedAt } = observed;
      const provider = observed.provider.usageLimitsByModel?.[candidate.model]
        ? {
            ...observed.provider,
            usageLimits: observed.provider.usageLimitsByModel[candidate.model],
          }
        : observed.provider;
      const email = provider.auth.email?.trim().toLowerCase();
      const fingerprint = provider.usageLimits?.credentialFingerprint;
      const identities = [
        ...(email ? [`${provider.driver}:account:${email}`] : []),
        ...(fingerprint ? [`${provider.driver}:credential:${fingerprint}`] : []),
        // Different API keys do not prove different subscription accounts.
        ...(provider.driver === "opencode"
          ? [
              `opencode:subscription:${candidate.model.startsWith("kimi-for-coding/") || candidate.model.startsWith("kimi-code-plan-global/") ? "kimi" : "go"}`,
            ]
          : []),
        ...(binding ? [`binding:${binding}`] : []),
      ];
      // Missing identity is never evidence of a second independently healthy account.
      if (!email && !fingerprint) continue;
      const scopedWindowIds =
        provider.driver === "claudeAgent"
          ? ["opus", "sonnet", "haiku"]
              .filter((family) => candidate.model.toLowerCase().includes(family))
              .map((family) => `seven_day_${family}`)
              .filter((id) => provider.usageLimits?.windows.some((w) => w.id === id))
          : provider.driver === "cursor"
            ? [candidate.model === "auto" ? "autoPercentUsed" : "apiPercentUsed"]
            : [];
      const scopedIdentities = (windowId: string) =>
        identities.map((key) => `${key}:quota:${windowId}`);
      const blockedScope = scopedWindowIds.find((id) =>
        scopedIdentities(id).some((key) => blocked.has(key)),
      );
      if (identities.some((key) => blocked.has(launchAttemptKey(key)))) {
        throttled = true;
        continue;
      }
      const blockedAccount = identities.some((key) => blocked.has(key));
      if (blockedAccount || blockedScope) {
        for (const key of blockedAccount ? identities : scopedIdentities(blockedScope!))
          blocked.add(key);
        exhausted = true;
        continue;
      }
      if (!provider.models.some((m) => m.slug === candidate.model)) continue;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const assessment = assessCapacity(
        provider.usageLimits,
        provider.driver,
        candidate.model,
        probeStartedAt,
        now,
      );
      if (assessment === "healthy" && provider.models.some((m) => m.slug === candidate.model)) {
        const options = supportedOptions(provider, candidate);
        return {
          status: "ready",
          selection: { ...candidate, ...(options ? { options } : {}) },
          domains: [...identities, ...scopedWindowIds.flatMap(scopedIdentities)],
        } as const;
      }
      if (assessment === "exhausted") {
        const exhaustedWindows = provider.usageLimits!.windows.filter(
          (window) => window.usedPercent >= 100,
        );
        // A model-specific window does not exhaust the account's other models.
        // Unknown evidence never establishes an exhausted quota domain.
        const shared =
          provider.usageLimits!.ordinaryUsageAllowed === false ||
          exhaustedWindows.some((window) =>
            provider.driver === "claudeAgent"
              ? !/^seven_day_(opus|sonnet|haiku)/.test(window.id)
              : provider.driver === "cursor"
                ? window.id === "totalPercentUsed"
                : true,
          );
        const domains = shared
          ? identities
          : scopedWindowIds.flatMap((id) =>
              exhaustedWindows.some((window) => window.id === id) ? scopedIdentities(id) : [],
            );
        for (const key of domains) blocked.add(key);
        exhausted = true;
      }
    }
    return {
      status: "waiting",
      reason: exhausted ? "exhausted" : throttled ? "throttled" : "unverified",
      retryAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 })),
    } as const;
  },
);

export class DelegatedLaunchAdmission extends Context.Service<
  DelegatedLaunchAdmission,
  {
    readonly check: (
      selection: ModelSelection,
      blockedDomains?: ReadonlyArray<string>,
      context?: { readonly projectId: ProjectId; readonly runtimeMode: RuntimeMode },
      launch?: { readonly runId: RunId; readonly generation: number },
    ) => Effect.Effect<AdmissionDecision, ServerSettingsError>;
    readonly markStarted: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<void, DelegatedLaunchAdmissionError>;
    readonly recover: (
      threadId: ThreadId,
      runId: RunId,
      launchGeneration: number,
      scope?: LaunchRefusalScope,
      refusedDomains?: ReadonlyArray<string>,
    ) => Effect.Effect<boolean, DelegatedLaunchAdmissionError>;
    /**
     * For a pool-bound launch that failed before useful work, the launcher's
     * authenticated binding state decides the refusal; native error text never does.
     */
    readonly recoverBoundLaunch: (
      threadId: ThreadId,
      runId: RunId,
      launchGeneration: number,
      failure: unknown,
    ) => Effect.Effect<boolean, DelegatedLaunchAdmissionError>;
    readonly prepare: (
      threadId: ThreadId,
      runId: RunId,
      generation: number,
    ) => Effect.Effect<boolean, DelegatedLaunchAdmissionError | WaitingForDelegatedCapacity>;
  }
>()("t3/orchestration-v2/DelegatedLaunchAdmission") {}

export const layer = Layer.effect(
  DelegatedLaunchAdmission,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const settings = yield* ServerSettings.ServerSettingsService;
    const check = Effect.fn("DelegatedLaunchAdmission.check")(function* (
      selection: ModelSelection,
      blockedDomains?: ReadonlyArray<string>,
      context?: { readonly projectId: ProjectId; readonly runtimeMode: RuntimeMode },
      launch?: { readonly runId: RunId; readonly generation: number },
    ) {
      const preferences = yield* settings.getSettings;
      const route = preferences.delegatedLaunchRoutes.find(
        (r) => r.from.instanceId === selection.instanceId && r.from.model === selection.model,
      );
      return yield* selectLaunchCandidate({
        candidates: [
          selection,
          ...(route?.fallback ?? []).map((fallback) => ({
            ...fallback,
            ...(fallback.options === undefined && selection.options
              ? { options: selection.options }
              : {}),
          })),
        ],
        ...(blockedDomains ? { blockedDomains } : {}),
        // Local runtime probes keep their own 8 second bound below.
        probeTimeout: "90 seconds",
        probe: Effect.fn("DelegatedLaunchAdmission.probe")(function* (candidate, blocked) {
          const instance = yield* instances.getInstance(candidate.instanceId);
          if (
            !instance?.enabled ||
            (context &&
              !resolveProjectProviderInstanceEnabled(
                preferences,
                context.projectId,
                candidate.instanceId,
              ))
          )
            return undefined;
          const probeStartedAt = DateTime.toEpochMillis(yield* DateTime.now);
          const pool = instance.delegatedLaunchPool;
          if (pool) {
            // The launcher owns authentication and account selection; the
            // catalog only says whether this instance can run the model.
            const catalog = yield* instance.snapshot.getSnapshot;
            if (
              !launch ||
              catalog.instanceId !== candidate.instanceId ||
              !catalog.enabled ||
              !catalog.installed ||
              !catalog.models.some((m) => m.slug === candidate.model) ||
              (context &&
                catalog.supportedRuntimeModes &&
                !catalog.supportedRuntimeModes.includes(context.runtimeMode))
            )
              return undefined;
            return {
              provider: catalog,
              probeStartedAt,
              pool: yield* pool.prepare({
                runId: launch.runId,
                generation: launch.generation,
                model: candidate.model,
                blockedQuotaDomains: [...blocked],
              }),
            };
          }
          // Codex requires runtime evidence, never a configuration assertion.
          if (instance.driverKind === "codex" && !instance.probeDelegatedLaunch) return undefined;
          const provider = yield* (
            instance.probeDelegatedLaunch
              ? instance.probeDelegatedLaunch(candidate.model)
              : instance.snapshot.refresh
          ).pipe(
            Effect.timeout("8 seconds"),
            Effect.orElseSucceed(() => undefined),
          );
          if (!provider) return undefined;
          if (
            context &&
            provider.supportedRuntimeModes &&
            !provider.supportedRuntimeModes.includes(context.runtimeMode)
          )
            return undefined;
          if (
            provider.instanceId !== candidate.instanceId ||
            provider.driver !== instance.driverKind ||
            !provider.enabled ||
            !provider.installed ||
            provider.status !== "ready" ||
            provider.auth.status !== "authenticated"
          )
            return undefined;
          const binding = instance.auth?.credentialBinding;
          return {
            provider,
            probeStartedAt,
            ...(binding ? { binding: `${binding.owner}:${binding.key}` } : {}),
          };
        }),
      });
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const recover = Effect.fn("DelegatedLaunchAdmission.recover")(
      function* (
        threadId: ThreadId,
        runId: RunId,
        launchGeneration: number,
        scope: LaunchRefusalScope = { type: "account" },
        refusedDomains: ReadonlyArray<string> = [],
      ) {
        const projection = yield* projections.getTurnStartContext(threadId, runId);
        const run = projection.runs.find((r) => r.id === runId);
        if (
          !run?.delegatedTaskId ||
          !run.delegatedLaunch ||
          run.delegatedLaunch.generation !== launchGeneration ||
          run.delegatedLaunch.admittedDomains.length === 0 ||
          run.delegatedLaunch.complete ||
          (run.status !== "running" && run.status !== "starting")
        )
          return false;
        const attempt = projection.attempts.find((a) => a.id === run.activeAttemptId);
        const providerThread = projection.providerThreads.find(
          (p) => p.id === run.providerThreadId,
        );
        if (!attempt || !providerThread) return false;
        const now = yield* DateTime.now;
        const generation = run.delegatedLaunch.generation + 1;
        const commandId = CommandId.make(`capacity-race:${run.id}:${generation}`);
        const providerSessionId = yield* ids.allocate.providerSession({
          providerInstanceId: run.providerInstanceId,
          threadId,
        });
        const base = {
          threadId,
          occurredAt: now,
          driver: providerThread.driver,
          providerInstanceId: run.providerInstanceId,
        };
        const events: Array<OrchestrationV2DomainEvent> = [
          {
            ...base,
            id: yield* ids.allocate.event({ threadId }),
            type: "run.updated",
            payload: {
              ...run,
              status: "starting",
              startedAt: null,
              delegatedLaunch: {
                ...run.delegatedLaunch,
                generation,
                blockedDomains: [
                  ...new Set([
                    ...run.delegatedLaunch.blockedDomains,
                    ...(scope.type === "candidate"
                      ? [launchCandidateKey(run.modelSelection)]
                      : scope.type === "attempt"
                        ? [launchAttemptKey(scope.domain)]
                        : [
                            ...refusedQuotaDomains(run.delegatedLaunch.admittedDomains, scope),
                            ...refusedDomains,
                          ]),
                  ]),
                ],
                admittedDomains: [],
                blockedUntil: DateTime.formatIso(DateTime.add(now, { minutes: 1 })),
              },
            },
          },
          {
            ...base,
            id: yield* ids.allocate.event({ threadId }),
            type: "run-attempt.updated",
            payload: {
              ...attempt,
              status: "pending",
              startedAt: null,
              providerTurnId: null,
            },
          },
          {
            ...base,
            id: yield* ids.allocate.event({ threadId }),
            type: "provider-thread.updated",
            payload: {
              ...providerThread,
              providerSessionId,
              nativeThreadRef: null,
              status: "not_loaded",
              updatedAt: now,
            },
          },
        ];
        const written = yield* sink.writeIfRunCurrent({
          threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: run.status,
          events,
          commandId,
          effects: [
            ...(providerThread.providerSessionId
              ? [
                  {
                    id: `effect:${commandId}:detach`,
                    commandId,
                    threadId,
                    request: {
                      type: "provider-session.detach" as const,
                      providerSessionId: providerThread.providerSessionId,
                    },
                  },
                ]
              : []),
            {
              id: `effect:${commandId}:start`,
              commandId,
              threadId,
              request: { type: "provider-turn.start", runId, launchGeneration: generation },
            },
          ],
        });
        return written.committed;
      },
      Effect.mapError((cause) => new DelegatedLaunchAdmissionError({ cause })),
    );
    const recoverBoundLaunch = Effect.fn("DelegatedLaunchAdmission.recoverBoundLaunch")(
      function* (threadId: ThreadId, runId: RunId, launchGeneration: number, failure: unknown) {
        const projection = yield* projections.getTurnStartContext(threadId, runId);
        const launch = projection.runs.find((r) => r.id === runId)?.delegatedLaunch;
        if (!launch?.binding || launch.complete || launch.generation !== launchGeneration)
          return false;
        const pool = (yield* instances.getInstance(launch.binding.instanceId))?.delegatedLaunchPool;
        const state = pool
          ? yield* pool.state(launch.binding).pipe(
              Effect.timeout("45 seconds"),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
        const expiredPending =
          state?.state === "pending" &&
          state.executorAttempts === 0 &&
          !state.active &&
          Date.parse(launch.binding.result.expiresAt) <=
            DateTime.toEpochMillis(yield* DateTime.now);
        const refusal = expiredPending
          ? { scope: { type: "candidate" as const } }
          : classifyPoolRefusal(state, isLaunchQuotaFailure(failure));
        if (!refusal) return false;
        return yield* recover(threadId, runId, launchGeneration, refusal.scope, refusal.domains);
      },
      Effect.mapError((cause) =>
        isDelegatedLaunchAdmissionError(cause)
          ? cause
          : new DelegatedLaunchAdmissionError({ cause }),
      ),
    );
    return DelegatedLaunchAdmission.of({
      check,
      markStarted: Effect.fn("DelegatedLaunchAdmission.markStarted")(
        function* (threadId, runId) {
          const projection = yield* projections.getTurnStartContext(threadId, runId);
          const run = projection.runs.find((r) => r.id === runId);
          if (!run?.delegatedLaunch || run.delegatedLaunch.complete || !run.activeAttemptId) return;
          const now = yield* DateTime.now;
          yield* sink.writeIfRunCurrent({
            threadId,
            runId,
            activeAttemptId: run.activeAttemptId,
            expectedStatus: "running",
            events: [
              {
                id: yield* ids.allocate.event({ threadId }),
                threadId,
                occurredAt: now,
                type: "run.updated",
                payload: { ...run, delegatedLaunch: { ...run.delegatedLaunch, complete: true } },
              },
            ],
          });
        },
        Effect.mapError((cause) => new DelegatedLaunchAdmissionError({ cause })),
      ),
      recover,
      recoverBoundLaunch,
      prepare: Effect.fn("DelegatedLaunchAdmission.prepare")(
        function* (threadId, runId, generation) {
          const projection = yield* projections.getTurnStartContext(threadId, runId);
          const run = projection.runs.find((r) => r.id === runId);
          if (!run) return true;
          if (run.status !== "starting") return false;
          if (!run.delegatedTaskId || run.workStartedAt || run.delegatedLaunch?.complete)
            return true;
          // Continuations share the original native pin, even when the new run
          // has no launch record. Admission must not turn prior work into a new launch.
          if (
            !run.delegatedLaunch &&
            projection.runs.some(
              (previous) =>
                previous.id !== run.id &&
                previous.delegatedTaskId === run.delegatedTaskId &&
                previous.providerThreadId === run.providerThreadId &&
                previous.providerInstanceId === run.providerInstanceId &&
                previous.delegatedLaunch?.binding !== undefined,
            )
          )
            return true;
          if ((run.delegatedLaunch?.generation ?? 0) !== generation) return false;
          const providerThread = projection.providerThreads.find(
            (p) => p.id === run.providerThreadId,
          );
          const attempt = projection.attempts.find((a) => a.id === run.activeAttemptId);
          if (!providerThread || !attempt) return true;
          const decision = yield* check(
            run.delegatedLaunch?.requested ?? run.modelSelection,
            run.delegatedLaunch &&
              Date.parse(run.delegatedLaunch.blockedUntil) >
                DateTime.toEpochMillis(yield* DateTime.now)
              ? run.delegatedLaunch.blockedDomains
              : [],
            { projectId: projection.thread.projectId, runtimeMode: projection.thread.runtimeMode },
            { runId: run.id, generation },
          );
          // A superseded lease is never launched: earlier generations failed
          // before useful work, and a changed blocked set is a new request.
          const previous = run.delegatedLaunch?.binding;
          if (
            previous &&
            (decision.status !== "ready" ||
              decision.binding?.prepareRequest.clientRequestId !==
                previous.prepareRequest.clientRequestId)
          ) {
            const pool = (yield* instances.getInstance(previous.instanceId))?.delegatedLaunchPool;
            if (pool)
              yield* Effect.all(
                [pool.cancel(previous.prepareRequest.clientRequestId), pool.release(previous)],
                { concurrency: "unbounded", discard: true },
              ).pipe(Effect.timeout("45 seconds"), Effect.ignore);
          }
          const now = yield* DateTime.now;
          const wait =
            decision.status === "waiting"
              ? {
                  reason: decision.reason,
                  checkedAt: DateTime.formatIso(now),
                  retryAt: decision.retryAt,
                }
              : undefined;
          const selection = decision.status === "ready" ? decision.selection : run.modelSelection;
          const instance = yield* instances.getInstance(selection.instanceId);
          const driver = instance?.driverKind ?? providerThread.driver;
          const events: Array<OrchestrationV2DomainEvent> = [];
          const base = {
            threadId,
            occurredAt: now,
            driver,
            providerInstanceId: selection.instanceId,
          };
          const { capacityWait: _, ...withoutWait } = run;
          events.push({
            ...base,
            id: yield* ids.allocate.event({ threadId }),
            type: "run.updated",
            payload: {
              ...withoutWait,
              modelSelection: selection,
              providerInstanceId: selection.instanceId,
              ...(wait ? { capacityWait: wait } : {}),
              delegatedLaunch: {
                requested: run.delegatedLaunch?.requested ?? run.modelSelection,
                blockedDomains: run.delegatedLaunch?.blockedDomains ?? [],
                admittedDomains: decision.status === "ready" ? decision.domains : [],
                generation: run.delegatedLaunch?.generation ?? 0,
                blockedUntil: run.delegatedLaunch?.blockedUntil ?? DateTime.formatIso(now),
                ...(decision.status === "ready" && decision.binding
                  ? { binding: decision.binding }
                  : {}),
              },
            },
          });
          if (decision.status === "ready") {
            // A lease belongs to exactly one bound native process, never a reused one.
            const switched =
              selection.instanceId !== run.providerInstanceId || decision.binding !== undefined;
            const providerSessionId = switched
              ? yield* ids.allocate.providerSession({
                  providerInstanceId: selection.instanceId,
                  threadId,
                })
              : providerThread.providerSessionId;
            events.push({
              ...base,
              id: yield* ids.allocate.event({ threadId }),
              type: "provider-thread.updated",
              payload: {
                ...providerThread,
                driver,
                providerInstanceId: selection.instanceId,
                providerSessionId,
                ...(switched
                  ? {
                      nativeThreadRef: null,
                      nativeConversationHeadRef: null,
                      nativeMetadata: null,
                      contextUsage: null,
                    }
                  : {}),
                updatedAt: now,
              },
            });
            events.push({
              ...base,
              id: yield* ids.allocate.event({ threadId }),
              type: "run-attempt.updated",
              payload: { ...attempt, providerInstanceId: selection.instanceId },
            });
            events.push({
              ...base,
              id: yield* ids.allocate.event({ threadId }),
              type: "thread.model-selection-updated",
              payload: {
                ...projection.thread,
                providerInstanceId: selection.instanceId,
                modelSelection: selection,
                updatedAt: now,
              },
            });
          }
          const parentId = projection.thread.lineage.parentThreadId;
          if (parentId) {
            const parent = yield* projections.getThreadRecords(parentId, [
              "subagents",
              "turnItems",
            ]);
            const task = parent.subagents.find((t) => t.id === run.delegatedTaskId);
            if (task) {
              const { capacityWait: _, ...taskWithoutWait } = task;
              events.push({
                ...base,
                threadId: parentId,
                id: yield* ids.allocate.event({ threadId: parentId }),
                type: "subagent.updated",
                payload: {
                  ...taskWithoutWait,
                  status: wait ? "waiting" : "running",
                  driver,
                  providerInstanceId: selection.instanceId,
                  model: selection.model,
                  modelSelection: selection,
                  ...(wait ? { capacityWait: wait } : {}),
                  updatedAt: now,
                },
              });
              for (const item of parent.turnItems) {
                if (item.type !== "subagent" || item.subagentId !== task.id) continue;
                events.push({
                  ...base,
                  threadId: parentId,
                  id: yield* ids.allocate.event({ threadId: parentId }),
                  type: "turn-item.updated",
                  payload: {
                    ...item,
                    status: wait ? "waiting" : "running",
                    title: wait ? "Waiting for capacity" : (task.title ?? "Delegated task"),
                    driver,
                    providerInstanceId: selection.instanceId,
                    updatedAt: now,
                  },
                });
              }
            }
          }
          const written = yield* sink.writeIfRunCurrent({
            threadId,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: "starting",
            events,
          });
          if (written.committed && decision.status === "waiting") {
            return yield* new WaitingForDelegatedCapacity({ retryAt: decision.retryAt });
          }
          return written.committed;
        },
        Effect.mapError((cause) =>
          isWaitingForDelegatedCapacity(cause)
            ? cause
            : new DelegatedLaunchAdmissionError({ cause }),
        ),
      ),
    });
  }),
);
