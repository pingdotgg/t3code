import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { createTranslator, type Translate } from "../i18n";

const english = createTranslator("en");

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
  readonly resolveText?: (t: Translate) => ProviderUpdateToastText;
  readonly dismissAfterVisibleMs?: number;
}

export interface ProviderUpdateToastText {
  readonly title: string;
  readonly description: string;
}

function localizedProviderUpdateToastView(
  view: Omit<ProviderUpdateToastView, "title" | "description" | "resolveText">,
  t: Translate,
  resolveText: (t: Translate) => ProviderUpdateToastText,
): ProviderUpdateToastView {
  return { ...view, ...resolveText(t), resolveText };
}

export function resolveProviderUpdateToastText(
  view: ProviderUpdateToastView,
  t: Translate,
): ProviderUpdateToastText {
  return view.resolveText?.(t) ?? view;
}

/**
 * Terminal update phases — outcomes that are safe to persist as a one-shot row
 * result. A non-terminal ("initial"/"running") snapshot never re-polls itself,
 * so storing one pins an update row's spinner indefinitely once its pending flag
 * expires; such phases must be dropped in favor of the live per-environment
 * provider state instead of being persisted.
 */
export function isTerminalProviderUpdatePhase(phase: ProviderUpdateToastPhase): boolean {
  return phase === "succeeded" || phase === "failed" || phase === "unchanged";
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
  readonly visibleAfterIso?: string;
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

function dedupeProvidersByInstanceId<T extends ServerProvider>(providers: ReadonlyArray<T>): T[] {
  const latestProviderByInstanceId = new Map<ProviderInstanceId, T>();

  for (const provider of providers) {
    const current = latestProviderByInstanceId.get(provider.instanceId);
    if (!current || provider.checkedAt.localeCompare(current.checkedAt) >= 0) {
      latestProviderByInstanceId.set(provider.instanceId, provider);
    }
  }

  return [...latestProviderByInstanceId.values()];
}

function getProviderUpdatedTitle(
  provider: Pick<ServerProvider, "driver" | "version">,
  t: Translate,
): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  return provider.version
    ? t("providerUpdate.success.namedVersion", {
        provider: providerName,
        version: formatVersion(provider.version),
      })
    : t("providerUpdate.success.named", { provider: providerName });
}

function getProviderUpdatedDescription(providerCount: number, t: Translate): string {
  return providerCount === 1
    ? t("providerUpdate.success.description")
    : t("providerUpdate.success.descriptionMany");
}

function getProviderFailedUpdateTitle(
  provider: Pick<ServerProvider, "driver" | "versionAdvisory">,
  t: Translate,
): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const attemptedVersion = provider.versionAdvisory?.latestVersion;
  return attemptedVersion
    ? t("providerUpdate.failed.namedVersion", {
        provider: providerName,
        version: formatVersion(attemptedVersion),
      })
    : t("providerUpdate.failed.named", { provider: providerName });
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

export function formatProviderList(
  providers: ReadonlyArray<Pick<ServerProvider, "driver">>,
  t: Translate = english,
) {
  const names = providers.map(
    (provider) => PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver,
  );
  if (names.length < 2) {
    return names[0] ?? "";
  }
  if (names.length === 2) {
    return t("providerUpdate.list.two", { first: names[0]!, second: names[1]! });
  }
  return t("providerUpdate.list.many", {
    prefix: names.slice(0, -1).join(", "),
    last: names[names.length - 1]!,
  });
}

export function getProviderUpdateInitialToastView(
  input: {
    readonly updateProviders: ReadonlyArray<ProviderUpdateCandidate>;
    readonly oneClickProviders: ReadonlyArray<ProviderUpdateCandidate>;
  },
  t: Translate = english,
): ProviderUpdateToastView {
  return localizedProviderUpdateToastView({ phase: "initial", type: "warning" }, t, (nextT) => ({
    title: getProviderUpdateInitialToastTitle(input.updateProviders, nextT),
    description:
      input.oneClickProviders.length > 0
        ? nextT("providerUpdate.initial.description")
        : nextT("providerUpdate.initial.manualDescription", {
            providers: formatProviderList(input.updateProviders, nextT),
          }),
  }));
}

export function shouldShowPrimaryProviderUpdateToast(view: ProviderUpdateToastView): boolean {
  return view.phase !== "running";
}

export function getProviderUpdateRunningToastView(
  providerCount: number,
  t: Translate = english,
): ProviderUpdateToastView {
  return localizedProviderUpdateToastView({ phase: "running", type: "loading" }, t, (nextT) => ({
    title:
      providerCount === 1
        ? nextT("providerUpdate.running.title")
        : nextT("providerUpdate.running.titleMany"),
    description: nextT("providerUpdate.running.description"),
  }));
}

export function getProviderUpdateRejectedToastView(
  providerCount: number,
  message: string,
  t: Translate = english,
): ProviderUpdateToastView {
  const isLocalizedFallback = message === t("providerUpdate.error.generic");
  return localizedProviderUpdateToastView({ phase: "failed", type: "error" }, t, (nextT) => ({
    title:
      providerCount === 1
        ? nextT("providerUpdate.failed.title")
        : nextT("providerUpdate.failed.titleMany"),
    description: isLocalizedFallback ? nextT("providerUpdate.error.generic") : message,
  }));
}

export function getProviderUpdateProgressToastView(
  input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly providerCount: number;
  },
  t: Translate = english,
): ProviderUpdateToastView {
  const providers = dedupeProvidersByDriver(input.providers);
  const failedProviders = providers.filter((provider) => provider.updateState?.status === "failed");
  if (failedProviders.length > 0) {
    return localizedProviderUpdateToastView({ phase: "failed", type: "error" }, t, (nextT) => ({
      title:
        failedProviders.length === 1
          ? nextT("providerUpdate.failed.title")
          : nextT("providerUpdate.failed.titleMany"),
      description: getFailedProviderUpdateDescription(failedProviders, nextT),
    }));
  }

  const unchangedProviders = providers.filter(
    (provider) => provider.updateState?.status === "unchanged",
  );
  if (unchangedProviders.length > 0) {
    return localizedProviderUpdateToastView(
      { phase: "unchanged", type: "warning" },
      t,
      (nextT) => ({
        title:
          unchangedProviders.length === 1
            ? nextT("providerUpdate.unchanged.title")
            : nextT("providerUpdate.unchanged.titleMany"),
        description: nextT(
          unchangedProviders.length === 1
            ? "providerUpdate.unchanged.description"
            : "providerUpdate.unchanged.descriptionMany",
          { providers: formatProviderList(unchangedProviders, nextT) },
        ),
      }),
    );
  }

  if (providers.some(isProviderUpdateActive)) {
    return getProviderUpdateRunningToastView(input.providerCount, t);
  }

  const hasCompleteProviderSnapshots = providers.length >= input.providerCount;
  const allProvidersUpdated =
    hasCompleteProviderSnapshots &&
    providers.every(
      (provider) =>
        provider.updateState?.status === "succeeded" || !isProviderUpdateCandidate(provider),
    );
  if (allProvidersUpdated) {
    return localizedProviderUpdateToastView(
      {
        phase: "succeeded",
        type: "success",
        dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
      },
      t,
      (nextT) => ({
        title:
          input.providerCount === 1
            ? nextT("providerUpdate.success.title")
            : nextT("providerUpdate.success.titleMany"),
        description: getProviderUpdatedDescription(input.providerCount, nextT),
      }),
    );
  }

  return getProviderUpdateRunningToastView(input.providerCount, t);
}

export function getSingleProviderUpdateProgressToastView(
  provider: ServerProvider,
  t: Translate = english,
): ProviderUpdateToastView {
  const view = getProviderUpdateProgressToastView(
    {
      providers: [provider],
      providerCount: 1,
    },
    t,
  );
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;

  switch (view.phase) {
    case "running":
      return localizedProviderUpdateToastView(view, t, (nextT) => ({
        ...resolveProviderUpdateToastText(view, nextT),
        title: nextT("providerUpdate.running.namedTitle", { provider: providerName }),
      }));
    case "failed":
      return localizedProviderUpdateToastView(view, t, (nextT) => ({
        ...resolveProviderUpdateToastText(view, nextT),
        title: getProviderFailedUpdateTitle(provider, nextT),
      }));
    case "unchanged":
      return localizedProviderUpdateToastView(view, t, (nextT) => ({
        ...resolveProviderUpdateToastText(view, nextT),
        title: nextT("providerUpdate.unchanged.named", { provider: providerName }),
      }));
    case "succeeded":
      return localizedProviderUpdateToastView(view, t, (nextT) => ({
        ...resolveProviderUpdateToastText(view, nextT),
        title: getProviderUpdatedTitle(provider, nextT),
      }));
    default:
      return view;
  }
}

export function collectUpdatedProviderSnapshots(input: {
  readonly results: ReadonlyArray<
    AtomCommandResult<{ readonly providers: ReadonlyArray<ServerProvider> }, unknown>
  >;
  readonly providerInstanceIds: ReadonlySet<ProviderInstanceId>;
}): ServerProvider[] {
  const matchedProviders: ServerProvider[] = [];

  for (const result of input.results) {
    if (result._tag === "Failure") {
      continue;
    }
    for (const provider of result.value.providers) {
      if (input.providerInstanceIds.has(provider.instanceId)) {
        matchedProviders.push(provider);
      }
    }
  }

  return dedupeProvidersByInstanceId(matchedProviders);
}

export function firstFailedProviderUpdateMessage(
  results: ReadonlyArray<AtomCommandResult<unknown, unknown>>,
  t: Translate = english,
): string | null {
  const failed = results.find((result) => result._tag === "Failure");
  if (!failed || failed._tag !== "Failure") {
    return null;
  }
  const error = squashAtomCommandFailure(failed);
  return error instanceof Error ? error.message : t("providerUpdate.error.generic");
}

function getUpdateFinishedAt(provider: ServerProvider): string | null {
  return provider.updateState?.finishedAt ?? null;
}

function isRecentTerminalProvider(
  provider: ServerProvider,
  visibleAfterIso: string | undefined,
): boolean {
  const status = provider.updateState?.status;
  if (status !== "failed" && status !== "unchanged" && status !== "succeeded") {
    return false;
  }
  if (visibleAfterIso === undefined) {
    return true;
  }
  const finishedAt = getUpdateFinishedAt(provider);
  return finishedAt !== null && finishedAt >= visibleAfterIso;
}

function latestFinishedAtForProviders(providers: ReadonlyArray<ServerProvider>): string | null {
  return providers.reduce<string | null>((latest, provider) => {
    const finishedAt = getUpdateFinishedAt(provider);
    if (finishedAt === null) {
      return latest;
    }
    return latest === null || finishedAt > latest ? finishedAt : latest;
  }, null);
}

export function getProviderUpdateSidebarPillView(
  providers: ReadonlyArray<ServerProvider>,
  options?: ProviderUpdateSidebarPillOptions,
  t: Translate = english,
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
          ? t("providerUpdate.running.namedTitle", { provider: activeProviderName })
          : t("providerUpdate.running.titleCount", { count: activeProviders.length }),
      description:
        activeProviders.length === 1
          ? t("providerUpdate.running.namedDescription", {
              providers: formatProviderList(activeProviders, t),
            })
          : t("providerUpdate.running.namedDescriptionMany", {
              providers: formatProviderList(activeProviders, t),
            }),
    };
  }

  const recentTerminalProviders = dedupedProviders.filter((provider) =>
    isRecentTerminalProvider(provider, options?.visibleAfterIso),
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
          ? getProviderFailedUpdateTitle(failedProvider, t)
          : t("providerUpdate.failed.titleCount", { count: failedProviders.length }),
      description: getFailedProviderUpdateDescription(failedProviders, t),
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
          ? t("providerUpdate.unchanged.named", { provider: unchangedProviderName })
          : t("providerUpdate.unchanged.titleCount", { count: unchangedProviders.length }),
      description: t(
        unchangedProviders.length === 1
          ? "providerUpdate.unchanged.description"
          : "providerUpdate.unchanged.descriptionMany",
        { providers: formatProviderList(unchangedProviders, t) },
      ),
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
          ? getProviderUpdatedTitle(succeededProvider, t)
          : t("providerUpdate.success.titleCount", { count: succeededProviders.length }),
      description: getProviderUpdatedDescription(succeededProviders.length, t),
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
        const leftFinishedAt = latestFinishedAtForProviders(leftProviders) ?? "";
        const rightFinishedAt = latestFinishedAtForProviders(rightProviders) ?? "";
        return rightFinishedAt.localeCompare(leftFinishedAt);
      })
      .find((candidate) => !options?.dismissedKeys?.has(candidate.key)) ?? null
  );
}

function getProviderUpdateInitialToastTitle(
  providers: ReadonlyArray<ProviderUpdateCandidate>,
  t: Translate,
): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
    return t("providerUpdate.initial.title", {
      provider: providerName,
      version: formatVersion(provider.versionAdvisory.latestVersion),
    });
  }
  return t("providerUpdate.initial.titleMany", { count: providers.length });
}

function getFailedProviderUpdateDescription(
  providers: ReadonlyArray<ServerProvider>,
  t: Translate,
): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    if (provider.updateState?.message) {
      return provider.updateState.message;
    }
  }
  return t("providerUpdate.failed.description", { providers: formatProviderList(providers, t) });
}

// ===========================================================================
// Multi-environment provider updates
//
// With a desktop-local secondary backend present (the WSL backend alongside the
// Windows primary), a provider update is applied across every local backend.
// Each environment owns its own provider instances, so candidates and progress
// are computed per environment and the dispatch targets that environment's
// connection. These helpers are pure; the dispatch itself runs through the
// `serverEnvironment.updateProvider` atom command in the components.
// ===========================================================================

/**
 * The settled result of dispatching a provider update to one local backend.
 * `provider` is the post-update snapshot of the targeted instance returned by
 * that backend (null when the backend did not report the targeted instance,
 * e.g. it does not have it installed).
 */
export interface LocalProviderUpdateOutcome {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | null;
}

// Worst-case ordering across backends: a failed copy outranks an unchanged one,
// which outranks a still-running one, which outranks a succeeded one.
const PROVIDER_UPDATE_STATUS_SEVERITY: Record<string, number> = {
  succeeded: 1,
  queued: 2,
  running: 2,
  unchanged: 3,
  failed: 4,
};

function providerUpdateOutcomeSeverity(provider: ServerProvider): number {
  return PROVIDER_UPDATE_STATUS_SEVERITY[provider.updateState?.status ?? ""] ?? 0;
}

export function firstRejectedProviderUpdateMessage(
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
  t: Translate = english,
): string | null {
  const rejected = results.find((result) => result.status === "rejected");
  if (!rejected) {
    return null;
  }
  return rejected.reason instanceof Error
    ? rejected.reason.message
    : t("providerUpdate.error.generic");
}

/**
 * Reduce per-backend update outcomes to one representative snapshot per driver,
 * keeping the worst-case status across every local backend. Because the same
 * driver has a distinct instance id per environment, a secondary backend (e.g.
 * WSL) that *resolved* with a failed or unchanged provider would otherwise be
 * filtered out (its instance id is not the primary's) or collapsed behind the
 * primary's success — this surfaces it instead.
 */
export function collectProviderUpdateOutcomeSnapshots(
  results: ReadonlyArray<PromiseSettledResult<LocalProviderUpdateOutcome>>,
): ServerProvider[] {
  const worstByDriver = new Map<ProviderDriverKind, ServerProvider>();
  for (const result of results) {
    if (result.status !== "fulfilled" || result.value.provider === null) {
      continue;
    }
    const provider = result.value.provider;
    const current = worstByDriver.get(provider.driver);
    if (
      !current ||
      providerUpdateOutcomeSeverity(provider) > providerUpdateOutcomeSeverity(current)
    ) {
      worstByDriver.set(provider.driver, provider);
    }
  }
  return [...worstByDriver.values()];
}

/**
 * The first secondary (non-primary) backend whose update resolved without
 * succeeding. The primary's own failed/unchanged state is already surfaced
 * inline in settings, so only secondaries (which have no inline row) need an
 * explicit callout.
 */
export function firstUnsuccessfulSecondaryProviderOutcome(
  results: ReadonlyArray<PromiseSettledResult<LocalProviderUpdateOutcome>>,
): { readonly provider: ServerProvider; readonly status: "failed" | "unchanged" } | null {
  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }
    const outcome = result.value;
    if (outcome.isPrimary || outcome.provider === null) {
      continue;
    }
    const status = outcome.provider.updateState?.status;
    if (status === "failed" || status === "unchanged") {
      return { provider: outcome.provider, status };
    }
  }
  return null;
}

const WSL_INSTANCE_ID_PREFIX = "wsl:";

/** The distro name from a WSL backend instance id ("wsl:ubuntu" -> "ubuntu"), or null for the default. */
export function parseWslDistroFromInstanceId(instanceId: string | undefined): string | null {
  if (!instanceId || !instanceId.startsWith(WSL_INSTANCE_ID_PREFIX)) {
    return null;
  }
  const distro = instanceId.slice(WSL_INSTANCE_ID_PREFIX.length).trim();
  return distro.length === 0 || distro === "default" ? null : distro;
}

/**
 * A human label that distinguishes local environments by platform (so the
 * popover shows "Windows" / "WSL" rather than the account name twice). WSL is
 * identified by its backend instance id; everything else falls back to the
 * reported OS, then the environment's own label.
 */
export function deriveEnvironmentDisplayLabel(input: {
  readonly isWsl: boolean;
  readonly wslDistro: string | null;
  readonly platformOs: ExecutionEnvironmentPlatformOs | undefined;
  readonly fallbackLabel: string;
}): string {
  if (input.isWsl) {
    return input.wslDistro ? `WSL · ${input.wslDistro}` : "WSL";
  }
  switch (input.platformOs) {
    case "windows":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return input.fallbackLabel;
  }
}

/** Connection state of a local environment, normalized across primary/secondary sources. */
export type EnvironmentUpdateConnectionState = "connecting" | "ready" | "disconnected" | "error";

export interface LocalEnvironmentProvidersInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly connectionState: EnvironmentUpdateConnectionState;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export interface LocalEnvironmentUpdateGroup {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  /** True while this environment's backend is still connecting (e.g. WSL booting). */
  readonly isSettling: boolean;
  /** Outdated, one-click-updatable providers in this environment. */
  readonly candidates: ProviderUpdateCandidate[];
  /** Full provider list for this environment, used to derive live update progress. */
  readonly providers: ReadonlyArray<ServerProvider>;
}

/**
 * Build one update group per local environment, pairing each environment's
 * outdated one-click candidates with its own provider list, and report whether
 * any environment is still settling (so the caller can defer the popover).
 */
export function buildLocalEnvironmentUpdateGroups(
  environments: ReadonlyArray<LocalEnvironmentProvidersInput>,
): { groups: LocalEnvironmentUpdateGroup[]; isAnySettling: boolean } {
  const groups = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    isPrimary: environment.isPrimary,
    isSettling: environment.connectionState === "connecting",
    candidates: collectProviderUpdateCandidates(environment.providers).filter((candidate) =>
      canOneClickUpdateProviderCandidate(candidate, environment.providers),
    ),
    providers: environment.providers,
  }));
  const isAnySettling = environments.some(
    (environment) => environment.connectionState === "connecting",
  );
  return { groups, isAnySettling };
}

/** Groups that actually have a one-click update available, in display order (primary first). */
export function environmentGroupsWithUpdates(
  groups: ReadonlyArray<LocalEnvironmentUpdateGroup>,
): LocalEnvironmentUpdateGroup[] {
  return groups.filter((group) => group.candidates.length > 0);
}

/**
 * Stable key over the set of (environment, driver, latest version) updates on
 * offer, so the popover is shown once per distinct set and re-shown when it
 * changes.
 */
export function localEnvironmentUpdateNotificationKey(
  groups: ReadonlyArray<LocalEnvironmentUpdateGroup>,
): string | null {
  const parts = environmentGroupsWithUpdates(groups)
    .map((group) => {
      const providerParts = group.candidates
        .map((candidate) => `${candidate.driver}:${candidate.versionAdvisory.latestVersion}`)
        .toSorted()
        .join(",");
      return `${group.environmentId}=${providerParts}`;
    })
    .toSorted();
  return parts.length > 0 ? parts.join("|") : null;
}

export type ProviderUpdateRowStatusKind = "idle" | "loading" | "success" | "failed" | "unchanged";

export interface ProviderUpdateRowStatus {
  readonly kind: ProviderUpdateRowStatusKind;
  readonly text: string;
}

export interface ProviderUpdateRowError {
  readonly text: string;
  readonly resolveText?: (t: Translate) => string;
}

function environmentProviderNames(group: LocalEnvironmentUpdateGroup): string {
  return group.candidates
    .map((candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver)
    .join(", ");
}

/**
 * Resolve one environment row's display from every available signal, in
 * priority order: a transport rejection, then the dispatch's own *terminal*
 * result payload (reliable even when a secondary backend's config does not
 * re-sync), then live server state (reliable even when the dispatch RPC is lost
 * to a reconnect), then the optimistic pending spinner, then the idle state.
 *
 * A non-terminal result snapshot ("running") is intentionally skipped rather
 * than treated as authoritative, so live server state can still drive the row
 * to its terminal status instead of pinning it on "Updating…".
 */
export function resolveEnvironmentUpdateRowStatus(
  input: {
    readonly group: LocalEnvironmentUpdateGroup;
    readonly error: string | ProviderUpdateRowError | undefined;
    readonly result: ProviderUpdateToastView | undefined;
    readonly pill: ProviderUpdateSidebarPillView | null;
    readonly isPending: boolean;
  },
  t: Translate = english,
): ProviderUpdateRowStatus {
  if (input.error) {
    return {
      kind: "failed",
      text:
        typeof input.error === "string"
          ? input.error
          : (input.error.resolveText?.(t) ?? input.error.text),
    };
  }
  if (input.result) {
    const resultText = resolveProviderUpdateToastText(input.result, t);
    switch (input.result.phase) {
      case "succeeded":
        return { kind: "success", text: t("providerUpdate.status.updated") };
      case "failed":
        return { kind: "failed", text: resultText.description };
      case "unchanged":
        return { kind: "unchanged", text: resultText.description };
      // "running" / "initial": non-terminal snapshot — fall through to live state.
    }
  }
  if (input.pill) {
    switch (input.pill.tone) {
      case "success":
        return { kind: "success", text: t("providerUpdate.status.updated") };
      case "error":
        return { kind: "failed", text: input.pill.description };
      case "warning":
        return { kind: "unchanged", text: input.pill.description };
      default:
        return { kind: "loading", text: t("providerUpdate.status.updating") };
    }
  }
  // A non-terminal result snapshot or the optimistic pending flag means an
  // update is still in flight — keep showing the spinner rather than reverting
  // to the Update button as if nothing happened.
  if (input.result || input.isPending) {
    return { kind: "loading", text: t("providerUpdate.status.updating") };
  }
  return { kind: "idle", text: environmentProviderNames(input.group) };
}
