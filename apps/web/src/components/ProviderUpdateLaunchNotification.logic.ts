import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

export type ProviderUpdateCandidate = ServerProvider & {
  readonly versionAdvisory: NonNullable<ServerProvider["versionAdvisory"]> & {
    readonly status: "behind_latest";
    readonly latestVersion: string;
  };
};

export type ProviderUpdateToastType = "warning" | "loading" | "error" | "success";
export type ProviderUpdateToastPhase = "initial" | "running" | "failed" | "unchanged" | "succeeded";

export interface ProviderUpdateToastView {
  readonly phase: ProviderUpdateToastPhase;
  readonly type: ProviderUpdateToastType;
  readonly title: string;
  readonly description: string;
  readonly dismissAfterVisibleMs?: number;
}

export type ProviderUpdateSidebarPillTone = "loading" | "warning" | "error" | "success";

export interface ProviderUpdateSidebarPillView {
  readonly key: string;
  readonly tone: ProviderUpdateSidebarPillTone;
  readonly title: string;
  readonly description: string;
  readonly dismissible?: boolean;
  readonly dismissAfterVisibleMs?: number;
}

interface ProviderUpdateSidebarPillOptions {
  readonly visibleAfterMs?: number;
  readonly dismissedKeys?: ReadonlySet<string>;
}

const PROVIDER_UPDATE_SUCCESS_VISIBLE_MS = 3_000;

function formatVersion(value: string): string {
  return value.startsWith("v") ? value : `v${value}`;
}

function chooseRepresentativeProvider(
  current: ServerProvider | undefined,
  candidate: ServerProvider,
): ServerProvider {
  if (!current) {
    return candidate;
  }
  const defaultInstanceId = defaultInstanceIdForDriver(candidate.driver);
  if (candidate.instanceId === defaultInstanceId) {
    return candidate;
  }
  if (current.instanceId === defaultInstanceId) {
    return current;
  }
  return candidate.checkedAt.localeCompare(current.checkedAt) >= 0 ? candidate : current;
}

function dedupeProvidersByDriver<T extends ServerProvider>(providers: ReadonlyArray<T>): T[] {
  const latestProviderByDriver = new Map<ProviderDriverKind, T>();

  for (const provider of providers) {
    latestProviderByDriver.set(
      provider.driver,
      chooseRepresentativeProvider(latestProviderByDriver.get(provider.driver), provider) as T,
    );
  }

  return [...latestProviderByDriver.values()];
}

function getProviderUpdatedTitle(provider: Pick<ServerProvider, "driver" | "version">): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  return provider.version
    ? `${providerName} updated: ${formatVersion(provider.version)}`
    : `${providerName} updated`;
}

function getProviderUpdatedDescription(providerCount: number): string {
  return providerCount === 1
    ? "New sessions will use the updated provider."
    : "New sessions will use the updated providers.";
}

function getProviderFailedUpdateTitle(
  provider: Pick<ServerProvider, "driver" | "versionAdvisory">,
): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const attemptedVersion = provider.versionAdvisory?.latestVersion;
  return attemptedVersion
    ? `${providerName} ${formatVersion(attemptedVersion)} update failed`
    : `${providerName} update failed`;
}

export function isProviderUpdateCandidate(
  provider: ServerProvider,
): provider is ProviderUpdateCandidate {
  return (
    provider.enabled &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.latestVersion !== null
  );
}

export function isProviderUpdateActive(provider: Pick<ServerProvider, "updateState">): boolean {
  return provider.updateState?.status === "queued" || provider.updateState?.status === "running";
}

export function collectProviderUpdateCandidates(
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateCandidate[] {
  return dedupeProvidersByDriver(providers.filter(isProviderUpdateCandidate));
}

export function hasOneClickUpdateProviderCandidate(
  candidate: ProviderUpdateCandidate,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  if (
    candidate.versionAdvisory.canUpdate !== true ||
    candidate.versionAdvisory.updateCommand === null
  ) {
    return false;
  }

  const driverProviders = providers.filter((provider) => provider.driver === candidate.driver);
  if (driverProviders.length === 0) {
    return false;
  }

  const updateCommands = new Set<string>();
  for (const provider of driverProviders) {
    if (!isProviderUpdateCandidate(provider)) {
      continue;
    }
    const advisory = provider.versionAdvisory;
    if (!advisory || advisory.canUpdate !== true || advisory.updateCommand === null) {
      return false;
    }
    updateCommands.add(advisory.updateCommand);
  }

  return updateCommands.size === 1;
}

export function canOneClickUpdateProviderCandidate(
  candidate: ProviderUpdateCandidate,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  return (
    !isProviderUpdateActive(candidate) && hasOneClickUpdateProviderCandidate(candidate, providers)
  );
}

export function providerUpdateNotificationKey(
  providers: ReadonlyArray<ProviderUpdateCandidate>,
): string | null {
  const parts = dedupeProvidersByDriver(providers)
    .map((provider) => {
      const advisory = provider.versionAdvisory;
      return [provider.driver, advisory.latestVersion].join(":");
    })
    .toSorted();

  return parts.length > 0 ? parts.join("|") : null;
}

export function providerUpdateCandidateKey(provider: ProviderUpdateCandidate): string {
  return providerUpdateNotificationKey([provider])!;
}

export function formatProviderList(providers: ReadonlyArray<Pick<ServerProvider, "driver">>) {
  const names = providers.map(
    (provider) => PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver,
  );
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function getProviderUpdateInitialToastView(input: {
  readonly updateProviders: ReadonlyArray<ProviderUpdateCandidate>;
  readonly oneClickProviders: ReadonlyArray<ProviderUpdateCandidate>;
}): ProviderUpdateToastView {
  return {
    phase: "initial",
    type: "warning",
    title: getProviderUpdateInitialToastTitle(input.updateProviders),
    description:
      input.oneClickProviders.length > 0
        ? "Install the update now or review provider settings."
        : `${formatProviderList(input.updateProviders)} can be updated from provider settings.`,
  };
}

export function getProviderUpdateRunningToastView(providerCount: number): ProviderUpdateToastView {
  return {
    phase: "running",
    type: "loading",
    title: providerCount === 1 ? "Updating provider" : "Updating providers",
    description: "Running provider update command.",
  };
}

export function getProviderUpdateRejectedToastView(
  providerCount: number,
  message: string,
): ProviderUpdateToastView {
  return {
    phase: "failed",
    type: "error",
    title: providerCount === 1 ? "Provider update failed" : "Provider updates failed",
    description: message,
  };
}

export function getProviderUpdateProgressToastView(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerCount: number;
}): ProviderUpdateToastView {
  const providers = dedupeProvidersByDriver(input.providers);
  const failedProviders = providers.filter((provider) => provider.updateState?.status === "failed");
  if (failedProviders.length > 0) {
    return {
      phase: "failed",
      type: "error",
      title: failedProviders.length === 1 ? "Provider update failed" : "Provider updates failed",
      description: getFailedProviderUpdateDescription(failedProviders),
    };
  }

  const unchangedProviders = providers.filter(
    (provider) => provider.updateState?.status === "unchanged",
  );
  if (unchangedProviders.length > 0) {
    return {
      phase: "unchanged",
      type: "warning",
      title:
        unchangedProviders.length === 1
          ? "Provider still needs an update"
          : "Providers still need updates",
      description: `${formatProviderList(unchangedProviders)} ${
        unchangedProviders.length === 1 ? "still appears" : "still appear"
      } outdated. Check provider settings for details.`,
    };
  }

  if (providers.some(isProviderUpdateActive)) {
    return getProviderUpdateRunningToastView(input.providerCount);
  }

  const hasCompleteProviderSnapshots = providers.length >= input.providerCount;
  const allProvidersUpdated =
    hasCompleteProviderSnapshots &&
    providers.every(
      (provider) =>
        provider.updateState?.status === "succeeded" || !isProviderUpdateCandidate(provider),
    );
  if (allProvidersUpdated) {
    return {
      phase: "succeeded",
      type: "success",
      title: input.providerCount === 1 ? "Provider updated" : "Provider updates finished",
      description: getProviderUpdatedDescription(input.providerCount),
      dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
    };
  }

  return getProviderUpdateRunningToastView(input.providerCount);
}

export function getSingleProviderUpdateProgressToastView(
  provider: ServerProvider,
): ProviderUpdateToastView {
  const view = getProviderUpdateProgressToastView({
    providers: [provider],
    providerCount: 1,
  });
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;

  switch (view.phase) {
    case "running":
      return {
        ...view,
        title: `Updating ${providerName}`,
      };
    case "failed":
      return {
        ...view,
        title: getProviderFailedUpdateTitle(provider),
      };
    case "unchanged":
      return {
        ...view,
        title: `${providerName} still needs an update`,
      };
    case "succeeded":
      return {
        ...view,
        title: getProviderUpdatedTitle(provider),
      };
    default:
      return view;
  }
}

export function collectUpdatedProviderSnapshots(input: {
  readonly results: ReadonlyArray<
    PromiseSettledResult<{ readonly providers: ReadonlyArray<ServerProvider> }>
  >;
  readonly providerKinds: ReadonlySet<ProviderDriverKind>;
}): ServerProvider[] {
  const matchedProviders: ServerProvider[] = [];

  for (const result of input.results) {
    if (result.status !== "fulfilled") {
      continue;
    }
    for (const provider of result.value.providers) {
      if (input.providerKinds.has(provider.driver)) {
        matchedProviders.push(provider);
      }
    }
  }

  return dedupeProvidersByDriver(matchedProviders);
}

export function firstRejectedProviderUpdateMessage(
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
): string | null {
  const rejected = results.find((result) => result.status === "rejected");
  if (!rejected) {
    return null;
  }
  return rejected.reason instanceof Error ? rejected.reason.message : "Provider update failed.";
}

function parseUpdateFinishedAtMs(provider: ServerProvider): number | null {
  const finishedAt = provider.updateState?.finishedAt;
  if (!finishedAt) {
    return null;
  }
  const parsed = Date.parse(finishedAt);
  return Number.isNaN(parsed) ? null : parsed;
}

function isRecentTerminalProvider(
  provider: ServerProvider,
  visibleAfterMs: number | undefined,
): boolean {
  const status = provider.updateState?.status;
  if (status !== "failed" && status !== "unchanged" && status !== "succeeded") {
    return false;
  }
  if (visibleAfterMs === undefined) {
    return true;
  }
  const finishedAtMs = parseUpdateFinishedAtMs(provider);
  return finishedAtMs !== null && finishedAtMs >= visibleAfterMs;
}

function latestFinishedAtMsForProviders(providers: ReadonlyArray<ServerProvider>): number | null {
  return providers.reduce<number | null>((latest, provider) => {
    const finishedAtMs = parseUpdateFinishedAtMs(provider);
    if (finishedAtMs === null) {
      return latest;
    }
    return latest === null || finishedAtMs > latest ? finishedAtMs : latest;
  }, null);
}

export function getProviderUpdateSidebarPillView(
  providers: ReadonlyArray<ServerProvider>,
  options?: ProviderUpdateSidebarPillOptions,
): ProviderUpdateSidebarPillView | null {
  const dedupedProviders = dedupeProvidersByDriver(providers);
  const activeProviders = dedupedProviders.filter(isProviderUpdateActive);
  if (activeProviders.length > 0) {
    const activeProvider = activeProviders[0]!;
    const activeProviderName =
      PROVIDER_DISPLAY_NAMES[activeProvider.driver] ?? activeProvider.driver;
    return {
      key: `loading:${activeProviders
        .map((provider) => `${provider.driver}:${provider.updateState?.status ?? "idle"}`)
        .toSorted()
        .join("|")}`,
      tone: "loading",
      title:
        activeProviders.length === 1
          ? `Updating ${activeProviderName}`
          : `Updating ${activeProviders.length} providers`,
      description:
        activeProviders.length === 1
          ? `${formatProviderList(activeProviders)} update in progress.`
          : `${formatProviderList(activeProviders)} updates are in progress.`,
    };
  }

  const recentTerminalProviders = dedupedProviders.filter((provider) =>
    isRecentTerminalProvider(provider, options?.visibleAfterMs),
  );
  const terminalCandidates: ProviderUpdateSidebarPillView[] = [];

  const failedProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "failed",
  );
  if (failedProviders.length > 0) {
    const failedProvider = failedProviders[0]!;
    terminalCandidates.push({
      key: `failed:${failedProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.finishedAt ?? "pending"}:${provider.updateState?.message ?? ""}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "error",
      title:
        failedProviders.length === 1
          ? getProviderFailedUpdateTitle(failedProvider)
          : `${failedProviders.length} provider updates failed`,
      description: getFailedProviderUpdateDescription(failedProviders),
      dismissible: true,
    });
  }

  const unchangedProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "unchanged",
  );
  if (unchangedProviders.length > 0) {
    const unchangedProvider = unchangedProviders[0]!;
    const unchangedProviderName =
      PROVIDER_DISPLAY_NAMES[unchangedProvider.driver] ?? unchangedProvider.driver;
    terminalCandidates.push({
      key: `unchanged:${unchangedProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.finishedAt ?? "pending"}:${provider.updateState?.message ?? ""}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "warning",
      title:
        unchangedProviders.length === 1
          ? `${unchangedProviderName} still needs an update`
          : `${unchangedProviders.length} providers still need updates`,
      description: `${formatProviderList(unchangedProviders)} ${
        unchangedProviders.length === 1 ? "still appears" : "still appear"
      } outdated. Review provider settings for details.`,
      dismissible: true,
    });
  }

  const succeededProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "succeeded",
  );
  if (succeededProviders.length > 0) {
    const succeededProvider = succeededProviders[0]!;
    terminalCandidates.push({
      key: `succeeded:${succeededProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.finishedAt ?? "pending"}:${provider.updateState?.message ?? ""}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "success",
      title:
        succeededProviders.length === 1
          ? getProviderUpdatedTitle(succeededProvider)
          : `${succeededProviders.length} providers updated`,
      description: getProviderUpdatedDescription(succeededProviders.length),
      dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
    });
  }

  return (
    terminalCandidates
      .toSorted((left, right) => {
        const leftProviders =
          left.tone === "error"
            ? failedProviders
            : left.tone === "warning"
              ? unchangedProviders
              : succeededProviders;
        const rightProviders =
          right.tone === "error"
            ? failedProviders
            : right.tone === "warning"
              ? unchangedProviders
              : succeededProviders;
        return (
          (latestFinishedAtMsForProviders(rightProviders) ?? 0) -
          (latestFinishedAtMsForProviders(leftProviders) ?? 0)
        );
      })
      .find((candidate) => !options?.dismissedKeys?.has(candidate.key)) ?? null
  );
}

function getProviderUpdateInitialToastTitle(
  providers: ReadonlyArray<ProviderUpdateCandidate>,
): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
    return `Update Available: ${providerName} ${formatVersion(provider.versionAdvisory.latestVersion)}`;
  }
  return `Updates Available: ${providers.length} providers`;
}

function getFailedProviderUpdateDescription(providers: ReadonlyArray<ServerProvider>): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    if (provider.updateState?.message) {
      return provider.updateState.message;
    }
  }
  return `${formatProviderList(providers)} failed to update. Check provider settings for details.`;
}
