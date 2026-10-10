import {
  type EnvironmentId,
  isProviderAvailable,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";

import type { EnvironmentThreadShell } from "./state/models.ts";

/**
 * Whether new threads in this project rotate accounts. A project's own default
 * model names the account it wants, so rotation leaves that project alone.
 */
export function rotatesAccountsForProject(
  project: Pick<ResolvedProjectSettings, "settings" | "sources">,
): boolean {
  return (
    project.settings.rotateProviderAccounts && project.sources.defaultModelSelection !== "project"
  );
}

/** The accounts the user marked for rotation in an environment's provider settings. */
export function rotationEligibleInstanceIds(
  instances: Readonly<Record<ProviderInstanceId, Pick<ProviderInstanceConfig, "rotate">>>,
): ReadonlySet<ProviderInstanceId> {
  const marked = new Set<ProviderInstanceId>();
  for (const [instanceId, instance] of Object.entries(instances)) {
    if (instance.rotate === true) marked.add(instanceId as ProviderInstanceId);
  }
  return marked;
}

/** Whether the account can start a thread on `model` right now. */
function canStart(provider: ServerProvider, model: string): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.auth.status === "authenticated" &&
    provider.models.some((candidate) => candidate.slug === model)
  );
}

/** An API key, or a probe that failed with nothing kept, reports no window. */
function reportsUsage(provider: ServerProvider): boolean {
  return (provider.usageLimits?.windows.length ?? 0) > 0;
}

/**
 * How full the account's fullest window is, 0..100. No provider says which
 * window a model draws from, so every window counts. A window that reset
 * before `asOf` holds nothing.
 */
function usedPercent(provider: ServerProvider, asOf: number): number {
  let used = 0;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= asOf) continue;
    used = Math.max(used, window.usedPercent);
  }
  return used;
}

export interface AccountRotationInput {
  readonly selection: Pick<ModelSelection, "instanceId" | "model">;
  readonly environmentId: EnvironmentId;
  /** `environmentId`'s providers. */
  readonly providers: ReadonlyArray<ServerProvider>;
  /** See `rotationEligibleInstanceIds`. An unmarked account is never rotated onto or away from. */
  readonly eligibleInstanceIds: ReadonlySet<ProviderInstanceId>;
  /**
   * The account already shown for this draft. It stays while it is still one
   * the draft could rotate onto, so usage reports and thread starts arriving
   * as the user writes do not move it.
   */
  readonly heldInstanceId?: ProviderInstanceId | null;
  /** May span environments; instance ids repeat across machines, so only `environmentId`'s count. */
  readonly threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "providerInstanceId" | "createdAt" | "lineage">
  >;
}

/**
 * The account a new thread should start on when the user left that choice to
 * T3: among the marked accounts of the selected provider that offer the
 * selected model, the one with the most usage left, then the one whose last
 * thread was started longest ago. Usage ranks them only when every one of
 * them reports it; otherwise they take turns by thread start alone.
 *
 * Only for a thread that has not started. Moving a started thread to another
 * account is a provider switch, which is the user's call.
 *
 * Resets are judged against the environment's latest provider report, not the
 * client's clock, which need not agree with the server's.
 */
export function chooseRotatedProviderInstance(input: AccountRotationInput): ProviderInstanceId {
  const { selection, providers } = input;
  const selected = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (selected === undefined || !input.eligibleInstanceIds.has(selected.instanceId)) {
    return selection.instanceId;
  }

  // Turns follow thread starts. Later messages would move an open draft from
  // account to account, and a subagent thread rides on its parent's account.
  const lastStartedAt = new Map<ProviderInstanceId, number>();
  for (const thread of input.threads) {
    if (
      thread.environmentId !== input.environmentId ||
      thread.lineage.relationshipToParent === "subagent"
    ) {
      continue;
    }
    const startedAt = Date.parse(thread.createdAt);
    if (startedAt > (lastStartedAt.get(thread.providerInstanceId) ?? 0)) {
      lastStartedAt.set(thread.providerInstanceId, startedAt);
    }
  }

  // The selection goes first, so a full tie keeps it and then the provider
  // list's own order. A selection that cannot start the thread gives way.
  const pool = [
    ...(canStart(selected, selection.model) ? [selected] : []),
    ...providers.filter(
      (candidate) =>
        candidate !== selected &&
        candidate.driver === selected.driver &&
        input.eligibleInstanceIds.has(candidate.instanceId) &&
        canStart(candidate, selection.model),
    ),
  ];
  const held = pool.find((candidate) => candidate.instanceId === input.heldInstanceId);
  if (held !== undefined) return held.instanceId;
  // One silent account would otherwise look emptier than every account that
  // reports, and take each new thread.
  const rankByUsage = pool.every(reportsUsage);
  const asOf = Math.max(...providers.map((provider) => Date.parse(provider.checkedAt)));
  let chosen = pool[0] ?? selected;
  for (const candidate of pool) {
    const usage = rankByUsage ? usedPercent(candidate, asOf) - usedPercent(chosen, asOf) : 0;
    const idle =
      (lastStartedAt.get(chosen.instanceId) ?? 0) - (lastStartedAt.get(candidate.instanceId) ?? 0);
    // Only a strictly better account replaces the current pick.
    if (usage < 0 || (usage === 0 && idle > 0)) chosen = candidate;
  }
  return chosen.instanceId;
}
