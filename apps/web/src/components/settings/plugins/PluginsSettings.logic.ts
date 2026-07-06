import type {
  MarketplaceVersion,
  PluginInstallBeginInput,
  PluginInstallConfirmInput,
  PluginInstallConfirmResult,
  PluginInstallStaged,
  PluginInfo,
  PluginSourcesAddInput,
  PluginSourcesAddResult,
  PluginSourcesRemoveInput,
  PluginState,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";

export const ALL_PLUGIN_SOURCES_VALUE = "__all__";

const RELAUNCH_STATES = new Set<PluginState>([
  "pending-remove",
  "pending-upgrade",
  "disabled",
  "disabled-by-host",
]);

export function pluginRequiresRelaunch(plugin: Pick<PluginInfo, "state">): boolean {
  return RELAUNCH_STATES.has(plugin.state);
}

export function pluginStateLabel(state: PluginState): string {
  switch (state) {
    case "active":
      return "Active";
    case "pending-remove":
      return "Pending removal";
    case "pending-upgrade":
      return "Pending upgrade";
    case "failed":
      return "Failed";
    case "disabled":
      return "Disabled";
    case "disabled-by-host":
      return "Disabled by host";
  }
}

export function pluginStateBadgeVariant(
  state: PluginState,
): "success" | "warning" | "error" | "secondary" | "outline" {
  switch (state) {
    case "active":
      return "success";
    case "failed":
      return "error";
    case "pending-remove":
    case "pending-upgrade":
    case "disabled-by-host":
      return "warning";
    case "disabled":
      return "secondary";
  }
}

export function latestMarketplaceVersion(
  versions: ReadonlyArray<MarketplaceVersion>,
): MarketplaceVersion | null {
  return versions[0] ?? null;
}

export function effectiveInstallSourceId(
  selectedSourceId: string,
  sources: ReadonlyArray<{ readonly id: string }>,
): string | null {
  if (selectedSourceId !== ALL_PLUGIN_SOURCES_VALUE) {
    return selectedSourceId;
  }
  return sources.length === 1 ? (sources[0]?.id ?? null) : null;
}

export function humanErrorMessage(error: unknown, fallback = "The operation failed."): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return fallback;
}

export function commandFailureMessage(
  result: AtomCommandResult<unknown, unknown>,
  fallback = "The operation failed.",
): string | null {
  if (AsyncResult.isSuccess(result)) {
    return null;
  }
  return humanErrorMessage(squashAtomCommandFailure(result), fallback);
}

export type PluginFlowResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

function commandFlowResult<A>(
  result: AtomCommandResult<A, unknown>,
  fallback: string,
): PluginFlowResult<A> {
  const failure = commandFailureMessage(result, fallback);
  if (failure !== null) {
    return { ok: false, error: failure };
  }
  if (AsyncResult.isSuccess(result)) {
    return { ok: true, value: result.value };
  }
  return { ok: false, error: fallback };
}

export async function addPluginSourceFlow(
  commands: {
    readonly addSource: (
      input: PluginSourcesAddInput,
    ) => Promise<AtomCommandResult<PluginSourcesAddResult, unknown>>;
  },
  url: string,
): Promise<PluginFlowResult<PluginSourcesAddResult>> {
  return commandFlowResult(
    await commands.addSource({ url: url.trim() }),
    "Could not add plugin source.",
  );
}

export async function removePluginSourceFlow(
  commands: {
    readonly removeSource: (
      input: PluginSourcesRemoveInput,
    ) => Promise<AtomCommandResult<{}, unknown>>;
  },
  sourceId: string,
): Promise<PluginFlowResult<{}>> {
  return commandFlowResult(
    await commands.removeSource({ sourceId }),
    "Could not remove plugin source.",
  );
}

export async function beginPluginInstallConsentFlow(
  commands: {
    readonly beginInstall: (
      input: PluginInstallBeginInput,
    ) => Promise<AtomCommandResult<PluginInstallStaged, unknown>>;
  },
  input: PluginInstallBeginInput,
): Promise<PluginFlowResult<PluginInstallStaged>> {
  return commandFlowResult(await commands.beginInstall(input), "Could not stage plugin install.");
}

export async function confirmPluginInstallConsentFlow(
  commands: {
    readonly confirmInstall: (
      input: PluginInstallConfirmInput,
    ) => Promise<AtomCommandResult<PluginInstallConfirmResult, unknown>>;
  },
  input: PluginInstallConfirmInput,
): Promise<PluginFlowResult<PluginInstallConfirmResult>> {
  return commandFlowResult(await commands.confirmInstall(input), "Could not install plugin.");
}

export async function abortPluginInstallConsentFlow(
  commands: {
    readonly abortInstall: (
      input: PluginInstallConfirmInput,
    ) => Promise<AtomCommandResult<{}, unknown>>;
  },
  input: PluginInstallConfirmInput,
): Promise<PluginFlowResult<{}>> {
  return commandFlowResult(await commands.abortInstall(input), "Could not cancel plugin install.");
}
