import type { ServerProvider } from "@t3tools/contracts";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  isProviderUpdateActive,
} from "../ProviderUpdateLaunchNotification.logic";
import { collectServerUpdateTargets, type UpdateOptionMachine } from "./updateEverything.logic";
import { resolveServerSelfUpdateCapability } from "~/versionSkew";
import {
  exactUpdateVersion,
  type ItemResolution,
  type UpdatePlanItem,
  type UpdateExecutionPlan,
} from "./updateEverythingPlan";

export function createUpdatePlanClaimOwner(
  claimId: string,
  wake: () => void,
  locks: LockManager | undefined,
) {
  const name = (id: string) => `t3code-update-plan-owner:${id}`;
  let release!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired!: () => void;
  let failed!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  const stopped = new AbortController();
  const waiting = new Set<string>();
  const holding = locks?.request(name(claimId), () => {
    acquired();
    return lifetime;
  });
  if (holding) void holding.catch(failed);
  else acquired();
  return {
    ready,
    isAlive: locks
      ? async (id: string | null) => {
          if (id === null) return false;
          const state = await locks.query();
          if (!state.held?.some((lock) => lock.name === name(id))) return false;
          if (!waiting.has(id)) {
            waiting.add(id);
            void locks
              .request(name(id), { signal: stopped.signal }, () => {})
              .then(
                () => {
                  waiting.delete(id);
                  wake();
                },
                () => {
                  waiting.delete(id);
                },
              );
          }
          return true;
        }
      : undefined,
    async [Symbol.asyncDispose]() {
      stopped.abort();
      release();
      await holding;
    },
  };
}

export function retryExecutionPlan(
  plan: UpdateExecutionPlan,
  appVersion: string,
  resolve: (item: UpdatePlanItem, recovering: boolean) => ItemResolution,
  claimRecovery?: {
    readonly plan: UpdateExecutionPlan;
    readonly rendererClaimId: string;
    readonly deadClaims: readonly UpdatePlanItem[];
  },
): UpdateExecutionPlan {
  if (
    (plan.phase !== "paused" && plan.phase !== "complete") ||
    plan.pausedReason === "expired" ||
    plan.pausedReason === "storage"
  )
    return plan;
  if (
    claimRecovery &&
    (plan.id !== claimRecovery.plan.id ||
      plan.phase !== claimRecovery.plan.phase ||
      plan.items.some((item) => {
        if (item.kind === "app" || item.status !== "claimed") return false;
        const matches = (observed: UpdatePlanItem) =>
          observed.key === item.key &&
          observed.status === item.status &&
          observed.claimId === item.claimId;
        return (
          !claimRecovery.plan.items.some(matches) ||
          (item.claimId !== claimRecovery.rendererClaimId &&
            !claimRecovery.deadClaims.some(matches))
        );
      }))
  )
    return plan;
  if (
    plan.items.some(
      (item) =>
        item.kind !== "app" &&
        (item.status === "claimed" || item.status === "unknown") &&
        resolve(item, true).status === "wait",
    )
  )
    return plan;
  const items = plan.items.map((item) => {
    if (item.kind === "app" && exactUpdateVersion(appVersion, item.targetVersion))
      return { ...item, status: "done" as const, message: null };
    if (item.status === "done" || item.status === "skipped" || item.status === "pending")
      return item;
    if (item.kind !== "app" && (item.status === "claimed" || item.status === "unknown")) {
      const result = resolve(item, true);
      if (result.status === "wait") return item;
      if (result.status === "done") return { ...item, status: "done" as const, message: null };
    }
    return {
      ...item,
      status: "pending" as const,
      claimId: null,
      message: null,
      retryRequested: true,
    };
  });
  const retryingServers = new Set(
    items
      .filter((item) => item.kind === "server" && item.status === "pending")
      .map((item) => item.environmentId),
  );
  return {
    ...plan,
    phase: items.some((item) => item.kind === "app" && item.status === "pending")
      ? "local"
      : "servers",
    pausedReason: null,
    items: items.map((item) =>
      item.kind === "provider" &&
      item.status === "skipped" &&
      item.message === "T3 update did not finish on this device" &&
      retryingServers.has(item.environmentId)
        ? { ...item, status: "pending", message: null }
        : item,
    ),
  };
}

type UpdatePlanSnapshot = {
  readonly ready: boolean;
  readonly machines: readonly UpdateOptionMachine[];
};

function isProviderCheckPending(provider: ServerProvider): boolean {
  if (provider.status === "error" || provider.versionAdvisory?.canUpdate === false) return false;
  return (
    provider.version === null ||
    !provider.versionAdvisory ||
    provider.versionAdvisory.latestVersion === null
  );
}

export function createUpdatePlanItemResolver(read: () => UpdatePlanSnapshot, wake: () => void) {
  const waits = new Map<string, { timer: ReturnType<typeof setTimeout>; expired: boolean }>();
  return {
    resolve(item: UpdatePlanItem, recovering: boolean): ItemResolution {
      const snapshot = read();
      const machine = snapshot.machines.find(
        (machine) => machine.environmentId === item.environmentId,
      );
      const result = resolveUpdatePlanItem(
        snapshot,
        item,
        recovering,
        waits.get(item.key)?.expired ?? false,
      );
      const provider =
        item.kind === "provider"
          ? machine?.providers.find(
              (provider) =>
                provider.driver === item.driver && provider.instanceId === item.instanceId,
            )
          : undefined;
      const waitingForReadiness =
        machine &&
        (machine.connectionPhase === "connecting" ||
          machine.connectionPhase === "reconnecting" ||
          !machine.sessionInitialized ||
          (machine.connected && machine.serverConfig === null) ||
          (provider &&
            isProviderCheckPending(provider) &&
            !isProviderUpdateActive(provider) &&
            machine.updateState.status !== "running"));
      if (result.status === "wait" && waitingForReadiness && !waits.has(item.key)) {
        const entry = {
          timer: setTimeout(() => {
            entry.expired = true;
            wake();
          }, 60_000),
          expired: false,
        };
        waits.set(item.key, entry);
      } else if (result.status !== "wait") {
        const waiting = waits.get(item.key);
        if (waiting) clearTimeout(waiting.timer);
        waits.delete(item.key);
      }
      return result;
    },
    dispose() {
      for (const waiting of waits.values()) clearTimeout(waiting.timer);
      waits.clear();
    },
  };
}

export function resolveUpdatePlanItem(
  snapshot: UpdatePlanSnapshot,
  item: UpdatePlanItem,
  recovering: boolean,
  readinessExpired = false,
): ItemResolution {
  if (!snapshot.ready) return { status: "wait" };
  const machine = snapshot.machines.find((machine) => machine.environmentId === item.environmentId);
  if (!machine)
    return { status: recovering ? "unknown" : "skipped", message: "Connection removed" };
  if (!machine.enabled)
    return { status: recovering ? "unknown" : "skipped", message: "Connection disabled" };
  if (machine.connectionPhase === "connecting" || machine.connectionPhase === "reconnecting")
    return readinessExpired
      ? {
          status: recovering ? "unknown" : "skipped",
          message: "Connection did not return within one minute",
        }
      : { status: "wait" };
  if (!machine.connected)
    return {
      status: recovering ? "unknown" : "skipped",
      message:
        machine.connectionPhase === "error"
          ? "Connection or authentication blocked"
          : "Connection is offline",
    };
  if (!machine.sessionInitialized || (machine.connected && machine.serverConfig === null))
    return readinessExpired
      ? {
          status: recovering ? "unknown" : "skipped",
          message: "Connection setup did not finish within one minute",
        }
      : { status: "wait" };
  if (!machine.sessionReady)
    return { status: recovering ? "unknown" : "skipped", message: "Not signed in" };
  if (machine.serverConfig?.environment.environmentId !== item.environmentId)
    return { status: recovering ? "unknown" : "skipped", message: "Environment identity changed" };
  if (item.kind === "server") {
    if (
      item.selfUpdate &&
      resolveServerSelfUpdateCapability(machine.serverConfig) !== item.selfUpdate
    )
      return {
        status: recovering ? "unknown" : "skipped",
        message: "T3 installation changed. Review this device again.",
      };
    if (machine.updateState.status === "running") return { status: "wait" };
    if (recovering)
      return {
        status: "unknown",
        message: "The previous T3 update has no saved completion. Review before retry.",
      };
    const { targets, skipped } = collectServerUpdateTargets(
      [machine],
      item.targetVersion,
      item.retryRequested === true,
    );
    if (targets.length > 0) return { status: "ready" };
    return skipped.length > 0
      ? { status: "skipped", message: skipped[0]!.reason }
      : item.retryRequested
        ? {
            status: "skipped",
            message:
              "The device is on a different version. Review its T3 update before updating tools.",
          }
        : { status: "done" };
  }
  if (item.kind === "app") return { status: "ready" };
  if (!machine.canManageProviders)
    return { status: recovering ? "unknown" : "skipped", message: "No provider update permission" };
  if (machine.updateState.status === "running") return { status: "wait" };
  const provider = machine.providers.find(
    (provider) => provider.driver === item.driver && provider.instanceId === item.instanceId,
  );
  if (!provider || !provider.enabled)
    return {
      status: recovering ? "unknown" : "skipped",
      message: "Provider instance removed or disabled",
    };
  if (isProviderUpdateActive(provider)) return { status: "wait" };
  if (
    provider.version &&
    (item.targetVersion === "latest"
      ? provider.versionAdvisory?.status === "current" &&
        provider.versionAdvisory.currentVersion !== null &&
        exactUpdateVersion(provider.version, provider.versionAdvisory.currentVersion)
      : exactUpdateVersion(provider.version, item.targetVersion))
  )
    return { status: "done" };
  if (provider.version && provider.version !== item.fromVersion)
    return {
      status: recovering ? "unknown" : "skipped",
      message: "Installed provider version changed. Review a new selection.",
    };
  if (isProviderCheckPending(provider))
    return readinessExpired
      ? {
          status: recovering ? "unknown" : "skipped",
          message: "Provider update check did not finish within one minute",
        }
      : { status: "wait" };
  if (recovering)
    return {
      status: "unknown",
      message: "Provider update result is not confirmed. Review before retry.",
    };
  const candidate = collectProviderUpdateCandidates(machine.providers).find(
    (candidate) => candidate.driver === item.driver && candidate.instanceId === item.instanceId,
  );
  if (!candidate || !canOneClickUpdateProviderCandidate(candidate, machine.providers))
    return { status: "skipped", message: "Provider can no longer update safely" };
  if (
    item.targetVersion !== "latest" &&
    candidate.versionAdvisory.latestVersion !== item.targetVersion
  )
    return {
      status: "skipped",
      message: "Available provider version changed. Review a new selection.",
    };
  if (candidate.version !== item.fromVersion)
    return {
      status: "skipped",
      message: "Installed provider version changed. Review a new selection.",
    };
  return { status: "ready" };
}
