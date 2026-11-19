import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export type ProviderUpdateCandidate = ServerProvider & {
  readonly versionAdvisory: NonNullable<ServerProvider["versionAdvisory"]> & {
    readonly status: "behind_latest";
    readonly latestVersion: string;
  };
};

export type ProviderSettingsUpdateCandidate = ServerProvider & {
  readonly versionAdvisory: NonNullable<ServerProvider["versionAdvisory"]> & {
    readonly canUpdate: true;
    readonly updateCommand: string;
  };
};

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

function getProviderUpdatedTitle(
  provider: Pick<ServerProvider, "driver" | "version" | "installedVersion">,
  resolve: MessageResolver,
): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const version = provider.installedVersion ?? provider.version;
  return version
    ? resolve(
        msg("{provider} updated: {version}", {
          provider: providerName,
          version: formatVersion(version),
        }),
      )
    : resolve(msg("{provider} updated", { provider: providerName }));
}

// Only OpenCode reports an installed CLI apart from a running external server.
export function getProviderRestartNotice(
  provider: Pick<ServerProvider, "version" | "installedVersion" | "updateState">,
): string | null {
  return provider.updateState?.status === "succeeded" &&
    provider.installedVersion != null &&
    provider.version != null &&
    provider.installedVersion !== provider.version
    ? provider.updateState.message
    : null;
}

function getProviderUpdatedDescription(providerCount: number, resolve: MessageResolver): string {
  return providerCount === 1
    ? resolve(msg("New sessions will use the updated provider."))
    : resolve(msg("New sessions will use the updated providers."));
}

function getProviderFailedUpdateTitle(
  provider: Pick<ServerProvider, "driver" | "versionAdvisory">,
  resolve: MessageResolver,
): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const attemptedVersion = provider.versionAdvisory?.latestVersion;
  return attemptedVersion
    ? resolve(
        msg("{provider} {version} update failed", {
          provider: providerName,
          version: formatVersion(attemptedVersion),
        }),
      )
    : resolve(msg("{provider} update failed", { provider: providerName }));
}

export function isProviderUpdateCandidate(
  provider: ServerProvider,
): provider is ProviderUpdateCandidate {
  return (
    provider.enabled &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "broken" &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "unsupported" &&
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

export function isProviderSettingsUpdateCandidate(
  provider: ServerProvider,
): provider is ProviderSettingsUpdateCandidate {
  return (
    provider.enabled &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "broken" &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "unsupported" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate === true &&
    provider.versionAdvisory.updateCommand !== null
  );
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

function formatProviderList(
  providers: ReadonlyArray<Pick<ServerProvider, "driver">>,
  resolve: MessageResolver,
) {
  const names = providers.map(
    (provider) => PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver,
  );
  if (names.length <= 1) return names.join("");
  if (names.length === 2) {
    return resolve(msg("{first} and {second}", { first: names[0], second: names[1] }));
  }
  return resolve(
    msg("{items}, and {last}", {
      items: names.slice(0, -1).join(", "),
      last: names[names.length - 1],
    }),
  );
}

export interface ProviderUpdateRun {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly result: AtomCommandResult<
    { readonly providers: ReadonlyArray<ServerProvider> },
    unknown
  >;
}

export function getProviderUpdateRunOutcome(
  run: ProviderUpdateRun,
  resolve: MessageResolver = m,
):
  | { readonly status: "interrupted" }
  | { readonly status: "updated"; readonly message: string | null }
  | { readonly status: "failed"; readonly line: string } {
  if (isAtomCommandInterrupted(run.result)) return { status: "interrupted" };
  const label = PROVIDER_DISPLAY_NAMES[run.driver] ?? run.driver;
  if (run.result._tag === "Failure") {
    const error = squashAtomCommandFailure(run.result);
    return {
      status: "failed",
      line: `${label}: ${thrownErrorMessage(error, resolve) ?? resolve(msg("Provider update failed."))}\n${run.machineLabel}`,
    };
  }
  const provider = run.result.value.providers.find(
    (candidate) => candidate.instanceId === run.instanceId,
  );
  const updateState = provider?.updateState;
  const restartNotice = provider ? getProviderRestartNotice(provider) : null;
  return updateState?.status === "succeeded"
    ? {
        status: "updated",
        message: restartNotice ? `${label}: ${restartNotice}\n${run.machineLabel}` : null,
      }
    : {
        status: "failed",
        line: `${label}: ${updateState?.message ?? resolve(msg("Provider update did not finish."))}\n${run.machineLabel}`,
      };
}

export function getProviderUpdateRunToastView(
  runs: ReadonlyArray<ProviderUpdateRun>,
  resolve: MessageResolver = m,
): {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description: string;
} | null {
  const settled = runs
    .map((run) => getProviderUpdateRunOutcome(run, resolve))
    .filter((outcome) => outcome.status !== "interrupted");
  if (settled.length === 0) {
    return null;
  }
  const failureLines = settled.flatMap((outcome) =>
    outcome.status === "failed" ? [outcome.line] : [],
  );
  const successMessages = [
    ...new Set(
      settled.flatMap((outcome) =>
        outcome.status === "updated" && outcome.message ? [outcome.message] : [],
      ),
    ),
  ];
  if (failureLines.length === 0) {
    return {
      type: "success",
      title:
        settled.length === 1
          ? resolve(msg("Provider updated"))
          : resolve(
              msg(
                "{count, plural, one {{count} providers updated} other {{count} providers updated}}",
                { count: settled.length },
              ),
            ),
      description:
        successMessages.join("\n") || getProviderUpdatedDescription(settled.length, resolve),
    };
  }
  return {
    type: "error",
    title:
      failureLines.length < settled.length
        ? resolve(
            msg(
              "{total, plural, one {{failed} of {total} provider updates failed} other {{failed} of {total} provider updates failed}}",
              {
                failed: failureLines.length,
                total: settled.length,
              },
            ),
          )
        : settled.length === 1
          ? resolve(msg("Provider update failed"))
          : resolve(msg("Provider updates failed")),
    description: [...failureLines, ...successMessages].join("\n"),
  };
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

/** Use each driver's latest finished instance so an older default-instance result cannot hide it. */
function latestTerminalProvidersByDriver(providers: ReadonlyArray<ServerProvider>) {
  const latestProviderByDriver = new Map<ProviderDriverKind, ServerProvider>();

  for (const provider of providers) {
    const current = latestProviderByDriver.get(provider.driver);
    if (!current || (getUpdateFinishedAt(provider) ?? "") >= (getUpdateFinishedAt(current) ?? "")) {
      latestProviderByDriver.set(provider.driver, provider);
    }
  }

  return [...latestProviderByDriver.values()];
}

export function getProviderUpdateSidebarPillView(
  providers: ReadonlyArray<ServerProvider>,
  options?: ProviderUpdateSidebarPillOptions,
  resolve: MessageResolver = m,
): ProviderUpdateSidebarPillView | null {
  // Filter active instances before deduplicating drivers because update state is per instance.
  const activeProviders = dedupeProvidersByDriver(providers.filter(isProviderUpdateActive));
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
          ? resolve(msg("Updating {provider}", { provider: activeProviderName }))
          : resolve(
              msg(
                "{count, plural, one {Updating {count} providers} other {Updating {count} providers}}",
                { count: activeProviders.length },
              ),
            ),
      description:
        activeProviders.length === 1
          ? resolve(
              msg("{providers} update in progress.", {
                providers: formatProviderList(activeProviders, resolve),
              }),
            )
          : resolve(
              msg("{providers} updates are in progress.", {
                providers: formatProviderList(activeProviders, resolve),
              }),
            ),
    };
  }

  const recentTerminalProviders = latestTerminalProvidersByDriver(
    providers.filter((provider) => isRecentTerminalProvider(provider, options?.visibleAfterIso)),
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
          ? getProviderFailedUpdateTitle(failedProvider, resolve)
          : resolve(
              msg(
                "{count, plural, one {{count} provider updates failed} other {{count} provider updates failed}}",
                { count: failedProviders.length },
              ),
            ),
      description: getFailedProviderUpdateDescription(failedProviders, resolve),
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
          ? resolve(msg("{provider} still needs an update", { provider: unchangedProviderName }))
          : resolve(
              msg(
                "{count, plural, one {{count} providers still need updates} other {{count} providers still need updates}}",
                { count: unchangedProviders.length },
              ),
            ),
      description:
        unchangedProviders.length === 1
          ? resolve(
              msg("{providers} still appears outdated. Review provider settings for details.", {
                providers: formatProviderList(unchangedProviders, resolve),
              }),
            )
          : resolve(
              msg("{providers} still appear outdated. Review provider settings for details.", {
                providers: formatProviderList(unchangedProviders, resolve),
              }),
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
          ? getProviderUpdatedTitle(succeededProvider, resolve)
          : resolve(
              msg(
                "{count, plural, one {{count} providers updated} other {{count} providers updated}}",
                { count: succeededProviders.length },
              ),
            ),
      description:
        [...new Set(succeededProviders.map(getProviderRestartNotice).filter(Boolean))].join("\n") ||
        getProviderUpdatedDescription(succeededProviders.length, resolve),
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

function getFailedProviderUpdateDescription(
  providers: ReadonlyArray<ServerProvider>,
  resolve: MessageResolver,
): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    if (provider.updateState?.message) {
      return provider.updateState.message;
    }
  }
  return resolve(
    msg("{providers} failed to update. Check provider settings for details.", {
      providers: formatProviderList(providers, resolve),
    }),
  );
}
