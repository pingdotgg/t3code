import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  isProviderAvailable,
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";

export type MobileWorkspace = "work" | "code";

export function mobileProviderInstanceKey(
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
): string {
  return `${environmentId}\u0000${providerInstanceId}`;
}

export function buildProviderDriverMap(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ReadonlyMap<string, ProviderDriverKind> {
  const drivers = new Map<string, ProviderDriverKind>();
  for (const [environmentId, config] of serverConfigs) {
    for (const provider of config.providers) {
      drivers.set(mobileProviderInstanceKey(environmentId, provider.instanceId), provider.driver);
    }
  }
  return drivers;
}

export function isHermesThread(
  thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "providerInstanceId" | "modelSelection" | "runtime"
  >,
  providerDrivers: ReadonlyMap<string, ProviderDriverKind>,
): boolean {
  const providerInstanceId =
    thread.runtime?.providerInstanceId ??
    thread.providerInstanceId ??
    thread.modelSelection.instanceId;
  const driver = providerDrivers.get(
    mobileProviderInstanceKey(thread.environmentId, providerInstanceId),
  );
  // Cached shells can arrive before server config. The canonical legacy
  // instance id is a safe fallback; custom instance ids wait for metadata.
  return driver === "hermes" || (driver === undefined && providerInstanceId === "hermes");
}

export function isHermesProviderInstance(
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  providerDrivers: ReadonlyMap<string, ProviderDriverKind>,
): boolean {
  const driver = providerDrivers.get(mobileProviderInstanceKey(environmentId, providerInstanceId));
  return driver === "hermes" || (driver === undefined && providerInstanceId === "hermes");
}

export function isMobileWorkspaceThread(
  thread: Pick<
    EnvironmentThreadShell,
    "archivedAt" | "environmentId" | "lineage" | "providerInstanceId" | "modelSelection" | "runtime"
  >,
  workspace: MobileWorkspace,
  providerDrivers: ReadonlyMap<string, ProviderDriverKind>,
): boolean {
  if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") {
    return false;
  }
  const isHermes = isHermesThread(thread, providerDrivers);
  return workspace === "work" ? isHermes : !isHermes;
}

export interface HermesConversationTarget {
  readonly project: EnvironmentProject;
  readonly modelSelection: ModelSelection;
}

/**
 * Resolves the existing project shell used only to route a Hermes launch.
 * Work UI never exposes this backing project, and `prepareWorkspace: false`
 * prevents project/worktree setup from leaking into the conversation.
 */
export function resolveHermesConversationTarget(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly requiredEnvironmentId: EnvironmentId | null;
}): HermesConversationTarget | null {
  for (const [environmentId, config] of input.serverConfigs) {
    if (input.requiredEnvironmentId !== null && environmentId !== input.requiredEnvironmentId) {
      continue;
    }
    const workDirectory = config.t3WorkDirectory;
    const project =
      workDirectory === undefined
        ? undefined
        : input.projects.find(
            (candidate) =>
              candidate.environmentId === environmentId &&
              candidate.workspaceRoot === workDirectory,
          );
    if (!project) continue;
    for (const provider of config.providers) {
      if (
        provider.driver !== "hermes" ||
        !provider.enabled ||
        !provider.installed ||
        provider.status !== "ready" ||
        !isProviderAvailable(provider)
      ) {
        continue;
      }
      const model =
        provider.models.find((candidate) => candidate.slug === "default") ??
        provider.models.find((candidate) => candidate.isDefault === true) ??
        provider.models[0];
      if (!model) continue;
      return {
        project,
        modelSelection: {
          instanceId: provider.instanceId,
          model: model.slug,
        },
      };
    }
  }
  return null;
}
