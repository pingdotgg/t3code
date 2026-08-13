import {
  type AuthSessionId,
  type BackgroundPolicySnapshot,
  type BackgroundScope,
  type ClientActivityLease,
  type ClientActivityReportInput,
  type HostPowerSnapshot,
  type RpcClientId,
} from "@t3tools/contracts";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
  type ResolvedBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

export class BackgroundPolicy extends Context.Service<
  BackgroundPolicy,
  {
    readonly reportClientActivity: (
      sessionId: AuthSessionId,
      rpcClientId: RpcClientId,
      input: ClientActivityReportInput,
    ) => Effect.Effect<void>;
    readonly removeRpcClient: (
      sessionId: AuthSessionId,
      rpcClientId: RpcClientId,
    ) => Effect.Effect<void>;
    readonly reportHostPowerState: (snapshot: HostPowerSnapshot) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<BackgroundPolicySnapshot>;
    readonly streamChanges: Stream.Stream<BackgroundPolicySnapshot>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: BackgroundPolicySnapshot;
        readonly changes: Stream.Stream<BackgroundPolicySnapshot>;
      },
      never,
      Scope.Scope
    >;
    readonly hasDemand: (scope: BackgroundScope) => Effect.Effect<boolean>;
    readonly shouldRunScopeWork: (scope: BackgroundScope) => Effect.Effect<boolean>;
    readonly shouldRunOpportunisticWork: Effect.Effect<boolean>;
  }
>()("t3/background/BackgroundPolicy") {}

const DEFAULT_LEASE_TTL_MS = 45_000;
const MAX_LEASE_TTL_MS = 120_000;
export const MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT = 16;

function scopeKey(scope: BackgroundScope): string {
  switch (scope.type) {
    case "server-config":
    case "diagnostics":
      return scope.type;
    case "provider-status":
      return scope.instanceId ? `${scope.type}:${scope.instanceId}` : scope.type;
    case "vcs-status":
    case "git-refs":
      return `${scope.type}:${scope.cwd}`;
    case "thread":
      return `${scope.type}:${scope.threadId}`;
  }
}

function isLeaseActive(lease: ClientActivityLease, now: DateTime.Utc): boolean {
  return DateTime.isGreaterThan(lease.expiresAt, now);
}

function leaseKey(lease: Pick<ClientActivityLease, "sessionId" | "rpcClientId" | "clientId">) {
  return JSON.stringify([lease.sessionId, lease.rpcClientId, lease.clientId]);
}

export function upsertClientActivityLease(
  leases: ReadonlyMap<string, ClientActivityLease>,
  lease: ClientActivityLease,
  now: DateTime.Utc,
): Map<string, ClientActivityLease> {
  const next = new Map(leases);
  for (const [key, current] of next) {
    if (!isLeaseActive(current, now)) {
      next.delete(key);
    }
  }

  const key = leaseKey(lease);
  if (!next.has(key)) {
    let connectionLeaseCount = 0;
    let oldestConnectionLease:
      | {
          readonly key: string;
          readonly updatedAtMs: number;
        }
      | undefined;
    for (const [currentKey, current] of next) {
      if (current.sessionId !== lease.sessionId || current.rpcClientId !== lease.rpcClientId) {
        continue;
      }
      connectionLeaseCount += 1;
      const updatedAtMs = DateTime.toEpochMillis(current.updatedAt);
      if (oldestConnectionLease === undefined || updatedAtMs < oldestConnectionLease.updatedAtMs) {
        oldestConnectionLease = { key: currentKey, updatedAtMs };
      }
    }
    if (
      connectionLeaseCount >= MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT &&
      oldestConnectionLease !== undefined
    ) {
      next.delete(oldestConnectionLease.key);
    }
  }

  next.set(key, lease);
  return next;
}

function isForegroundLease(lease: ClientActivityLease, now: DateTime.Utc): boolean {
  return isLeaseActive(lease, now) && lease.visible && (lease.focused || lease.recentlyInteracted);
}

function leaseHasScope(lease: ClientActivityLease, scope: BackgroundScope): boolean {
  const key = scopeKey(scope);
  return lease.scopes.some((leaseScope) => scopeKey(leaseScope) === key);
}

function hasThermalPressure(hostPower: HostPowerSnapshot): boolean {
  return hostPower.thermalState === "serious" || hostPower.thermalState === "critical";
}

function isHostConstrained(
  hostPower: HostPowerSnapshot,
  settings: ResolvedBackgroundActivitySettings,
): boolean {
  if (hostPower.stale) return false;
  if (
    hostPower.suspended ||
    (settings.pauseWhenHostLocked && hostPower.locked === "true") ||
    hasThermalPressure(hostPower)
  ) {
    return true;
  }
  if (settings.pauseWhenHostLowPower && hostPower.lowPowerMode === "true") return true;
  return settings.pauseWhenOnBattery && hostPower.onBattery === "true";
}

function isClientConstrained(
  lease: ClientActivityLease,
  settings: ResolvedBackgroundActivitySettings,
): boolean {
  if (settings.pauseWhenClientLowPower && lease.lowPowerMode === "true") return true;
  return settings.pauseWhenOnBattery && lease.batteryState === "unplugged";
}

function leaseMayRunScopedWork(
  lease: ClientActivityLease,
  scope: BackgroundScope,
  now: DateTime.Utc,
  settings: ResolvedBackgroundActivitySettings,
): boolean {
  const activeWithScope = isLeaseActive(lease, now) && leaseHasScope(lease, scope);
  if (!activeWithScope || isClientConstrained(lease, settings)) {
    return false;
  }
  if (settings.profile === "performance") {
    return true;
  }
  return isForegroundLease(lease, now);
}

function computeSnapshot(input: {
  readonly hostPower: HostPowerSnapshot;
  readonly leases: ReadonlyMap<string, ClientActivityLease>;
  readonly now: DateTime.Utc;
  readonly settings: ResolvedBackgroundActivitySettings;
  readonly updatedAt: DateTime.Utc;
}): BackgroundPolicySnapshot {
  const activeLeases = [...input.leases.values()].filter((lease) =>
    isLeaseActive(lease, input.now),
  );
  const foregroundLeases = activeLeases.filter((lease) => isForegroundLease(lease, input.now));
  const activeScopeKeys = new Set<string>();
  for (const lease of activeLeases) {
    for (const scope of lease.scopes) {
      activeScopeKeys.add(scopeKey(scope));
    }
  }

  return {
    hostPower: input.hostPower,
    leases: activeLeases,
    activeForegroundLeaseCount: foregroundLeases.length,
    activeScopeKeys: [...activeScopeKeys].toSorted(),
    shouldRunOpportunisticWork:
      foregroundLeases.some((lease) => !isClientConstrained(lease, input.settings)) &&
      !isHostConstrained(input.hostPower, input.settings),
    updatedAt: input.updatedAt,
  };
}

export const make = Effect.fn("background.policy.make")(function* () {
  const hostPowerMonitor = yield* HostPowerMonitor.HostPowerMonitor;
  const serverSettings = yield* ServerSettingsService;
  const leasesRef = yield* Ref.make(new Map<string, ClientActivityLease>());
  const changes = yield* PubSub.sliding<BackgroundPolicySnapshot>(1);
  const publishMutex = yield* Semaphore.make(1);

  const backgroundActivitySettings = serverSettings.getSettings.pipe(
    Effect.map(resolveServerBackgroundActivitySettings),
    Effect.orElseSucceed(() => getBackgroundActivityPresetSettings("balanced")),
  );

  const snapshot = Effect.gen(function* () {
    const [hostPower, leases, now, settings] = yield* Effect.all([
      hostPowerMonitor.snapshot,
      Ref.get(leasesRef),
      DateTime.now,
      backgroundActivitySettings,
    ]);
    return computeSnapshot({ hostPower, leases, now, settings, updatedAt: now });
  });

  const publishSnapshotUnlocked = snapshot.pipe(
    Effect.flatMap((next) => PubSub.publish(changes, next)),
  );
  const publishSnapshot = publishMutex.withPermits(1)(publishSnapshotUnlocked);

  const reportClientActivity: BackgroundPolicy["Service"]["reportClientActivity"] = (
    sessionId,
    rpcClientId,
    input,
  ) =>
    publishMutex.withPermits(1)(
      Effect.gen(function* () {
        const ttlMs = Math.min(
          Math.max(input.ttlMs ?? DEFAULT_LEASE_TTL_MS, 1_000),
          MAX_LEASE_TTL_MS,
        );
        const now = yield* DateTime.now;
        const expiresAt = DateTime.add(now, { milliseconds: ttlMs });
        const lease: ClientActivityLease = {
          sessionId,
          rpcClientId,
          clientId: input.clientId,
          clientKind: input.clientKind,
          visible: input.visible,
          focused: input.focused,
          recentlyInteracted: input.recentlyInteracted,
          ...(input.appState !== undefined ? { appState: input.appState } : {}),
          ...(input.lowPowerMode !== undefined ? { lowPowerMode: input.lowPowerMode } : {}),
          ...(input.batteryState !== undefined ? { batteryState: input.batteryState } : {}),
          ...(input.networkType !== undefined ? { networkType: input.networkType } : {}),
          scopes: input.scopes,
          updatedAt: now,
          expiresAt,
        };
        yield* Ref.update(leasesRef, (leases) => upsertClientActivityLease(leases, lease, now));
        yield* publishSnapshotUnlocked;
      }),
    );

  const removeRpcClient: BackgroundPolicy["Service"]["removeRpcClient"] = (
    sessionId,
    rpcClientId,
  ) =>
    publishMutex.withPermits(1)(
      Ref.update(leasesRef, (leases) => {
        const next = new Map(leases);
        for (const [key, lease] of next) {
          if (lease.sessionId === sessionId && lease.rpcClientId === rpcClientId) {
            next.delete(key);
          }
        }
        return next;
      }).pipe(Effect.andThen(publishSnapshotUnlocked), Effect.asVoid),
    );

  const hasDemand: BackgroundPolicy["Service"]["hasDemand"] = (scope) =>
    Effect.map(snapshot, (current) => current.activeScopeKeys.includes(scopeKey(scope)));

  const shouldRunScopeWork: BackgroundPolicy["Service"]["shouldRunScopeWork"] = (scope) =>
    Effect.gen(function* () {
      const [current, settings] = yield* Effect.all([snapshot, backgroundActivitySettings]);
      if (isHostConstrained(current.hostPower, settings)) {
        return false;
      }
      return current.leases.some((lease) =>
        leaseMayRunScopedWork(lease, scope, current.updatedAt, settings),
      );
    });

  const shouldRunOpportunisticWork = Effect.map(
    snapshot,
    (current) => current.shouldRunOpportunisticWork,
  );

  yield* Stream.runForEach(hostPowerMonitor.streamChanges, () => publishSnapshot).pipe(
    Effect.forkScoped,
  );
  yield* Stream.runForEach(serverSettings.streamChanges, () => publishSnapshot).pipe(
    Effect.forkScoped,
  );

  yield* Effect.forever(
    Effect.sleep("15 seconds").pipe(
      Effect.andThen(
        publishMutex.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* Ref.update(leasesRef, (leases) => {
              const next = new Map(leases);
              for (const [key, lease] of next) {
                if (!isLeaseActive(lease, now)) {
                  next.delete(key);
                }
              }
              return next;
            });
            yield* publishSnapshotUnlocked;
          }),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);

  return BackgroundPolicy.of({
    reportClientActivity,
    removeRpcClient,
    reportHostPowerState: hostPowerMonitor.report,
    snapshot,
    streamChanges: Stream.fromPubSub(changes),
    subscribe: subscribeBeforeSnapshot(changes, snapshot, publishMutex),
    hasDemand,
    shouldRunScopeWork,
    shouldRunOpportunisticWork,
  });
});

export const layer = Layer.effect(BackgroundPolicy, make());
