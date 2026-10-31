import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2LimitRecovery,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;
const AUTO_REDEEM_RETRY_BACKOFF_MS = 60_000;

export function codexAutoResetIdempotencyKey(accountFingerprint: string, resetAt: string) {
  return `codex-auto-reset:${accountFingerprint}:${resetAt}`;
}

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
  autoRedeemCodexResetCredit = false,
  freshAccountMatches = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    (resetMs > nowMs &&
      (!autoRedeemCodexResetCredit ||
        !freshAccountMatches ||
        !(
          recovery.codexResetRedemption?.outcome === "reset" &&
          recovery.codexResetRedemption.allowanceCleared === true &&
          recovery.codexResetRedemption.providerInstanceId === thread.providerInstanceId &&
          recovery.codexResetRedemption.checkedAt !== undefined &&
          Date.parse(recovery.codexResetRedemption.checkedAt) >
            Date.parse(recovery.codexResetRedemption.attemptedAt)
        ))) ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}:${resetMs > nowMs ? `credit:${recovery.codexResetRedemption?.idempotencyKey}:${recovery.codexResetRedemption?.checkedAt}` : "natural"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const due = DueHint.make();
  const probeNotBefore = new Map<ProviderInstanceId, number>();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      autoRedeemCodexResetCreditInstanceIds: Object.entries(
        preferences.autoRedeemCodexResetCredits ?? {},
      )
        .filter(([, enabled]) => enabled)
        .map(([instanceId]) => ProviderInstanceId.make(instanceId)),
    });
    let acted = false;
    let retryAt: number | undefined;
    for (const thread of candidates) {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
        preferences.autoRedeemCodexResetCredits?.[thread.providerInstanceId] === true,
      );
      if (command === null) continue;
      const changed = yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          return yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        }
        yield* threads.dispatch(command);
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (changed) acted = true;
    }

    const limitedForAutoResume = candidates.filter(
      (thread) =>
        thread.lastErrorClass === "usage_limit" &&
        thread.latestRunId !== null &&
        typeof thread.usageLimitResetAt === "string" &&
        Date.parse(thread.usageLimitResetAt) > nowMs &&
        thread.limitRecovery?.runId === thread.latestRunId &&
        thread.limitRecovery.resetAt === thread.usageLimitResetAt &&
        thread.limitRecovery.autoResume &&
        preferences.autoResumeLimitedThreads &&
        preferences.autoRedeemCodexResetCredits?.[thread.providerInstanceId] === true,
    );
    const refreshedInstances = new Map<
      ProviderInstanceId,
      ReadonlyArray<import("@t3tools/contracts").ServerProvider>
    >();
    const knownProviders = new Map(
      limitedForAutoResume.length === 0
        ? []
        : (yield* providers.getProviders).map((provider) => [provider.instanceId, provider]),
    );
    for (const thread of limitedForAutoResume) {
      if (
        knownProviders.get(thread.providerInstanceId)?.usageLimits?.credentialFingerprint ||
        thread.limitRecovery?.codexResetRedemption?.accountFingerprint
      )
        continue;
      const notBefore = probeNotBefore.get(thread.providerInstanceId) ?? 0;
      if (notBefore > nowMs) {
        retryAt = Math.min(retryAt ?? Infinity, notBefore);
        continue;
      }
      const snapshots = yield* providers.refreshInstance(thread.providerInstanceId);
      refreshedInstances.set(thread.providerInstanceId, snapshots);
      const provider = snapshots.find(
        (candidate) => candidate.instanceId === thread.providerInstanceId,
      );
      if (provider) knownProviders.set(thread.providerInstanceId, provider);
      probeNotBefore.set(thread.providerInstanceId, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
      retryAt = Math.min(retryAt ?? Infinity, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
    }
    const groups = new Map<string, typeof limitedForAutoResume>();
    for (const thread of limitedForAutoResume) {
      if (!(yield* providers.supportsAutoRedeemResetCredit(thread.providerInstanceId))) continue;
      const fingerprint =
        knownProviders.get(thread.providerInstanceId)?.usageLimits?.credentialFingerprint ??
        thread.limitRecovery?.codexResetRedemption?.accountFingerprint;
      if (!fingerprint) continue;
      const group = groups.get(fingerprint) ?? [];
      groups.set(fingerprint, [...group, thread]);
    }

    for (const [fingerprint, group] of groups) {
      const attempt = yield* projections.getCodexResetAttempt(fingerprint);
      const attemptExpired = attempt !== null && Date.parse(attempt.resetAt) <= nowMs;
      const completedWindow =
        attempt?.outcome === "reset" &&
        attempt.allowanceCleared &&
        group.some((candidate) => candidate.usageLimitResetAt !== attempt.resetAt);
      if (attempt && !attemptExpired && !completedWindow && attempt.nextCheckAt !== undefined) {
        const nextCheck = Date.parse(attempt.nextCheckAt);
        if (nextCheck > nowMs) {
          retryAt = Math.min(retryAt ?? Infinity, nextCheck);
          continue;
        }
      }
      const candidatesForGroup = [...group].sort((left, right) => {
        if (completedWindow) {
          const priority =
            Number(right.usageLimitResetAt !== attempt?.resetAt) -
            Number(left.usageLimitResetAt !== attempt?.resetAt);
          if (priority !== 0) return priority;
        }
        const leftAt = Date.parse(left.limitRecovery?.codexResetRedemption?.attemptedAt ?? "");
        const rightAt = Date.parse(right.limitRecovery?.codexResetRedemption?.attemptedAt ?? "");
        return leftAt - rightAt;
      });
      const driverThread = candidatesForGroup[0];
      if (!driverThread) continue;
      const known = knownProviders.get(driverThread.providerInstanceId);
      const previousReport = driverThread.limitRecovery?.codexResetRedemption;
      const row =
        attemptExpired ||
        completedWindow ||
        attempt?.outcome === "noCredit" ||
        attempt?.outcome === "nothingToReset"
          ? null
          : attempt;
      let driverProvider = known;
      const notBefore = probeNotBefore.get(driverThread.providerInstanceId) ?? 0;
      if (notBefore > nowMs && row?.outcome !== "reset") {
        retryAt = Math.min(retryAt ?? Infinity, notBefore);
        continue;
      }
      if (row?.outcome === "reset") {
        const nextCheckAt = DateTime.formatIso(
          DateTime.makeUnsafe(nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS),
        );
        yield* projections.updateCodexResetAttempt({ ...row, nextCheckAt });
        let driverAllowanceCleared = false;
        let driverCheckedAt: string | undefined;
        let driverLimitsMatch = false;
        for (const candidate of candidatesForGroup) {
          const instanceId = candidate.providerInstanceId;
          let candidateProvider = knownProviders.get(instanceId);
          const refreshed = refreshedInstances.get(instanceId);
          if (refreshed !== undefined) {
            candidateProvider = refreshed.find((provider) => provider.instanceId === instanceId);
          } else {
            const candidateNotBefore = probeNotBefore.get(instanceId) ?? 0;
            if (candidateNotBefore <= nowMs) {
              probeNotBefore.set(instanceId, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
              retryAt = Math.min(retryAt ?? Infinity, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
              const snapshots = yield* providers
                .refreshInstance(instanceId)
                .pipe(Effect.catchCause(() => Effect.succeed([])));
              refreshedInstances.set(instanceId, snapshots);
              candidateProvider = snapshots.find((provider) => provider.instanceId === instanceId);
              if (candidateProvider) knownProviders.set(instanceId, candidateProvider);
            } else {
              retryAt = Math.min(retryAt ?? Infinity, candidateNotBefore);
              candidateProvider = undefined;
            }
          }
          const limits = candidateProvider?.usageLimits;
          const checkedAt =
            limits?.credentialFingerprint === fingerprint ? limits.checkedAt : undefined;
          const freshAndClear =
            candidateProvider?.driver === "codex" &&
            limits?.credentialFingerprint === fingerprint &&
            checkedAt !== undefined &&
            Date.parse(checkedAt) > Date.parse(row.attemptedAt) &&
            limits.unavailable === undefined &&
            exhaustedUsageWindow(candidateProvider, nowMs, candidate.modelSelection.model) ===
              undefined;
          if (candidate.id === driverThread.id) {
            driverAllowanceCleared = freshAndClear;
            driverCheckedAt = checkedAt;
            driverLimitsMatch = limits?.credentialFingerprint === fingerprint;
          }
          const report = {
            providerInstanceId: candidate.providerInstanceId,
            redeemedByProviderInstanceId:
              previousReport?.redeemedByProviderInstanceId ?? driverThread.providerInstanceId,
            accountFingerprint: fingerprint,
            accountLabel:
              candidateProvider?.auth?.email ??
              candidateProvider?.displayName ??
              previousReport?.accountLabel ??
              "Codex account",
            idempotencyKey: row.idempotencyKey,
            attemptedAt: row.attemptedAt,
            creditsBefore:
              candidate.limitRecovery?.codexResetRedemption?.creditsBefore ??
              previousReport?.creditsBefore ??
              1,
            outcome: "reset" as const,
            ...(checkedAt === undefined ? {} : { checkedAt }),
            allowanceCleared: freshAndClear,
          };
          const saved = yield* orchestrator.recordCodexResetRedemption({
            commandId: CommandId.make(`limit-credit-view:${candidate.id}:${candidate.latestRunId}`),
            threadId: candidate.id,
            runId: candidate.latestRunId!,
            resetAt: candidate.usageLimitResetAt!,
            codexResetRedemption: report,
          });
          if (saved) acted = true;
          if (freshAndClear) {
            const command = limitRecoveryCommand(
              {
                ...candidate,
                limitRecovery: { ...candidate.limitRecovery!, codexResetRedemption: report },
              },
              preferences.autoResumeLimitedThreads,
              nowMs,
              preferences.snoozeLimitedThreads,
              true,
              true,
            );
            if (command?.type === "message.dispatch") {
              yield* threads.dispatch(command);
              acted = true;
            }
          }
        }
        yield* projections.updateCodexResetAttempt({
          ...row,
          allowanceCleared: driverAllowanceCleared,
          ...(driverLimitsMatch && driverCheckedAt !== undefined
            ? { checkedAt: driverCheckedAt }
            : {}),
          nextCheckAt,
        });
        retryAt = Math.min(retryAt ?? Infinity, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
        continue;
      }

      if (
        !driverProvider ||
        driverProvider.driver !== "codex" ||
        (driverProvider.usageLimits?.credentialFingerprint !== undefined &&
          driverProvider.usageLimits.credentialFingerprint !== fingerprint)
      ) {
        retryAt = Math.min(retryAt ?? Infinity, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
        continue;
      }

      const attemptedAt = row?.attemptedAt ?? DateTime.formatIso(now);
      const idempotencyKey =
        row?.idempotencyKey ??
        codexAutoResetIdempotencyKey(fingerprint, driverThread.usageLimitResetAt!);
      const pendingReport = {
        providerInstanceId: driverThread.providerInstanceId,
        redeemedByProviderInstanceId: row
          ? (previousReport?.redeemedByProviderInstanceId ?? driverThread.providerInstanceId)
          : driverThread.providerInstanceId,
        accountFingerprint: fingerprint,
        accountLabel:
          driverProvider?.auth?.email ??
          driverProvider?.displayName ??
          previousReport?.accountLabel ??
          "Codex account",
        idempotencyKey,
        attemptedAt,
        creditsBefore: row
          ? (previousReport?.creditsBefore ?? 0)
          : (driverProvider?.usageLimits?.resetCredits?.availableCount ?? 0),
        outcome: "pending" as const,
      } satisfies NonNullable<OrchestrationV2LimitRecovery["codexResetRedemption"]>;
      let activeRow = row;
      if (activeRow === null) {
        activeRow = {
          accountFingerprint: fingerprint,
          resetAt: driverThread.usageLimitResetAt!,
          idempotencyKey,
          attemptedAt,
          outcome: "pending",
          allowanceCleared: false,
          nextCheckAt: DateTime.formatIso(
            DateTime.makeUnsafe(nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS),
          ),
        };
        if (!(yield* projections.claimCodexResetAttempt(activeRow, now))) continue;
      } else {
        activeRow = {
          ...activeRow,
          nextCheckAt: DateTime.formatIso(
            DateTime.makeUnsafe(nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS),
          ),
        };
        yield* projections.updateCodexResetAttempt(activeRow);
      }
      const mode = row?.outcome === "pending" ? "replay" : "first";
      probeNotBefore.set(driverThread.providerInstanceId, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
      const result = yield* providers
        .autoRedeemResetCredit({
          instanceId: driverThread.providerInstanceId,
          model: driverThread.modelSelection.model,
          idempotencyKey,
          resetAt: activeRow.resetAt,
          expectedAccountFingerprint: fingerprint,
          mode,
          stillArmed: Effect.fn("UsageLimitRecoveryWorker.stillArmed")(function* () {
            return yield* Effect.catchCause(
              Effect.gen(function* () {
                const currentPreferences = yield* settings.getSettings;
                if (
                  !currentPreferences.autoResumeLimitedThreads ||
                  currentPreferences.autoRedeemCodexResetCredits[
                    driverThread.providerInstanceId
                  ] !== true
                )
                  return false;
                return yield* orchestrator.recordCodexResetRedemption({
                  commandId: CommandId.make(
                    `limit-credit-final-check:${driverThread.id}:${driverThread.latestRunId}`,
                  ),
                  threadId: driverThread.id,
                  runId: driverThread.latestRunId!,
                  resetAt: driverThread.usageLimitResetAt!,
                  codexResetRedemption: pendingReport,
                });
              }),
              () => Effect.succeed(false),
            );
          }),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.codex-reset-redemption-failed", {
              threadId: driverThread.id,
              providerInstanceId: driverThread.providerInstanceId,
              accountFingerprint: fingerprint,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
      const nextCheckAt = DateTime.formatIso(
        DateTime.makeUnsafe(nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS),
      );
      if (result === null) {
        if (mode === "first")
          yield* projections.releaseCodexResetAttempt(fingerprint, idempotencyKey);
        else yield* projections.updateCodexResetAttempt({ ...activeRow, nextCheckAt });
        retryAt = Math.min(retryAt ?? Infinity, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
        continue;
      }
      const resultReport = { ...pendingReport, creditsBefore: result.creditsBefore } as const;
      if (result.status === "notSent") {
        if (mode === "first") {
          yield* projections.releaseCodexResetAttempt(fingerprint, idempotencyKey);
          if (result.reason === "notExhausted" || result.reason === "noCredit") {
            const outcome = result.reason === "noCredit" ? "noCredit" : "nothingToReset";
            const report = { ...resultReport, outcome, allowanceCleared: false } as const;
            yield* orchestrator.recordCodexResetRedemption({
              commandId: CommandId.make(
                `limit-credit-not-sent:${driverThread.id}:${driverThread.latestRunId}`,
              ),
              threadId: driverThread.id,
              runId: driverThread.latestRunId!,
              resetAt: driverThread.usageLimitResetAt!,
              codexResetRedemption: report,
            });
          } else if (result.reason === "declined") {
            yield* orchestrator.recordCodexResetRedemption({
              commandId: CommandId.make(
                `limit-credit-declined:${driverThread.id}:${driverThread.latestRunId}`,
              ),
              threadId: driverThread.id,
              runId: driverThread.latestRunId!,
              resetAt: driverThread.usageLimitResetAt!,
              codexResetRedemption: { ...resultReport, outcome: "declined" },
            });
          }
        } else {
          yield* projections.updateCodexResetAttempt({ ...activeRow, nextCheckAt });
          if (result.reason === "declined")
            yield* orchestrator.recordCodexResetRedemption({
              commandId: CommandId.make(
                `limit-credit-declined:${driverThread.id}:${driverThread.latestRunId}`,
              ),
              threadId: driverThread.id,
              runId: driverThread.latestRunId!,
              resetAt: driverThread.usageLimitResetAt!,
              codexResetRedemption: { ...resultReport, outcome: "declined" },
            });
        }
        retryAt = Math.min(retryAt ?? Infinity, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
        continue;
      }
      if (result.status === "sentUnknown") {
        yield* projections.updateCodexResetAttempt({ ...activeRow, nextCheckAt });
        retryAt = Math.min(retryAt ?? Infinity, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
        continue;
      }
      const outcome =
        result.outcome === "reset" || result.outcome === "alreadyRedeemed"
          ? "reset"
          : result.outcome === "noCredit"
            ? "noCredit"
            : "nothingToReset";
      const confirmed =
        outcome === "reset" &&
        result.accountFingerprint === fingerprint &&
        result.allowanceCleared &&
        result.checkedAt !== undefined &&
        Date.parse(result.checkedAt) > Date.parse(attemptedAt);
      const report = {
        ...resultReport,
        outcome,
        allowanceCleared: confirmed,
      } as const;
      const accountResult: ProjectionStore.CodexResetAttempt = {
        ...activeRow,
        outcome,
        allowanceCleared: confirmed,
        ...(result.accountFingerprint === fingerprint && result.checkedAt !== undefined
          ? { checkedAt: result.checkedAt }
          : {}),
        nextCheckAt,
      };
      yield* projections.updateCodexResetAttempt(accountResult);
      for (const candidate of candidatesForGroup) {
        let candidateProvider = knownProviders.get(candidate.providerInstanceId);
        if (candidate.providerInstanceId === driverThread.providerInstanceId) {
          candidateProvider = driverProvider;
        } else if (outcome === "reset") {
          const candidateNotBefore = probeNotBefore.get(candidate.providerInstanceId) ?? 0;
          if (candidateNotBefore <= nowMs) {
            probeNotBefore.set(candidate.providerInstanceId, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
            const snapshots = yield* providers
              .refreshInstance(candidate.providerInstanceId)
              .pipe(Effect.catchCause(() => Effect.succeed([])));
            refreshedInstances.set(candidate.providerInstanceId, snapshots);
            candidateProvider = snapshots.find(
              (provider) => provider.instanceId === candidate.providerInstanceId,
            );
          } else {
            retryAt = Math.min(retryAt ?? Infinity, candidateNotBefore);
          }
        }
        const limits = candidateProvider?.usageLimits;
        const candidateClear =
          outcome === "reset" &&
          ((candidate.providerInstanceId === driverThread.providerInstanceId &&
            candidate.modelSelection.model === driverThread.modelSelection.model &&
            result.accountFingerprint === fingerprint &&
            result.allowanceCleared &&
            result.checkedAt !== undefined &&
            Date.parse(result.checkedAt) > Date.parse(attemptedAt)) ||
            (limits?.credentialFingerprint === fingerprint &&
              candidate.providerInstanceId !== driverThread.providerInstanceId &&
              limits.checkedAt !== undefined &&
              Date.parse(limits.checkedAt) > Date.parse(attemptedAt) &&
              limits.unavailable === undefined &&
              candidateProvider !== undefined &&
              exhaustedUsageWindow(candidateProvider, nowMs, candidate.modelSelection.model) ===
                undefined));
        const sharedReport = {
          ...report,
          providerInstanceId: candidate.providerInstanceId,
          redeemedByProviderInstanceId: driverThread.providerInstanceId,
          accountLabel:
            candidateProvider?.auth?.email ?? candidateProvider?.displayName ?? report.accountLabel,
          ...(candidate.providerInstanceId === driverThread.providerInstanceId
            ? result.accountFingerprint !== fingerprint || result.checkedAt === undefined
              ? {}
              : { checkedAt: result.checkedAt }
            : candidateClear && limits?.checkedAt !== undefined
              ? { checkedAt: limits.checkedAt }
              : {}),
          allowanceCleared: candidateClear,
        } as const;
        const saved = yield* orchestrator.recordCodexResetRedemption({
          commandId: CommandId.make(`limit-credit-result:${candidate.id}:${candidate.latestRunId}`),
          threadId: candidate.id,
          runId: candidate.latestRunId!,
          resetAt: candidate.usageLimitResetAt!,
          codexResetRedemption: sharedReport,
        });
        if (saved) acted = true;
        if (candidateClear) {
          const command = limitRecoveryCommand(
            {
              ...candidate,
              limitRecovery: { ...candidate.limitRecovery!, codexResetRedemption: sharedReport },
            },
            preferences.autoResumeLimitedThreads,
            nowMs,
            preferences.snoozeLimitedThreads,
            true,
            true,
          );
          if (command?.type === "message.dispatch") {
            yield* threads.dispatch(command);
            acted = true;
          }
        }
      }
      retryAt = Math.min(retryAt ?? Infinity, nowMs + AUTO_REDEEM_RETRY_BACKOFF_MS);
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    yield* due.record(readVersion, Math.min(wakeAt ?? Infinity, retryAt ?? Infinity), nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
