import type { VoiceSupervisorRepositoryDependencies } from "@t3tools/client-runtime/operations/voice-supervisor-repository";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ModelSelection,
  type ProjectReadFileResult,
  type ServerConfig,
  type ThreadEnvMode,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { resolveDefaultThreadEnvMode } from "@t3tools/shared/threadEnvMode";

import { buildModelOptions, resolveDefaultableModelSelection } from "../lib/modelOptions";

type MaybePromise<T> = T | Promise<T>;

interface EnvironmentProjectRequest {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly cwd: string;
    readonly relativePath: string;
  };
}

interface EnvironmentRefsRequest {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly cwd: string;
    readonly limit: 100;
  };
}

export interface VoiceMobileStartDefaultsResolverDependencies {
  readonly readTargetServerConfig: (
    environmentId: EnvironmentId,
  ) => MaybePromise<ServerConfig | null>;
  readonly readProjectFile: (
    request: EnvironmentProjectRequest,
  ) => MaybePromise<ProjectReadFileResult | null>;
  readonly listRefs: (
    request: EnvironmentRefsRequest,
  ) => MaybePromise<Pick<VcsListRefsResult, "isRepo" | "refs">>;
}

export type VoiceMobileStartDefaultsUnavailableReason =
  | "target-environment-unavailable"
  | "provider-unavailable"
  | "model-unavailable"
  | "git-unavailable"
  | "worktree-base-unavailable";

export class VoiceMobileStartDefaultsUnavailableError extends Error {
  override readonly name = "VoiceMobileStartDefaultsUnavailableError";

  constructor(readonly reason: VoiceMobileStartDefaultsUnavailableReason) {
    super(`Voice start defaults unavailable: ${reason}.`);
  }
}

function isUsableProvider(provider: ServerConfig["providers"][number]): boolean {
  return provider.enabled && provider.installed && provider.auth.status !== "unauthenticated";
}

function resolveModelSelection(
  config: ServerConfig,
  projectDefault: EnvironmentProject["defaultModelSelection"],
): ModelSelection {
  const usableProviders = config.providers.filter(isUsableProvider);
  if (usableProviders.length === 0) {
    throw new VoiceMobileStartDefaultsUnavailableError("provider-unavailable");
  }

  const resolvedProjectDefault = resolveDefaultableModelSelection(config, projectDefault ?? null);
  const configuredOptions = buildModelOptions(config, null);
  const projectOptions = buildModelOptions(config, resolvedProjectDefault);
  const realProjectDefault =
    resolvedProjectDefault === null
      ? null
      : (projectOptions.find(
          (option) =>
            option.selection.instanceId === resolvedProjectDefault.instanceId &&
            option.selection.model === resolvedProjectDefault.model &&
            usableProviders.some(
              (provider) =>
                provider.instanceId === resolvedProjectDefault.instanceId &&
                provider.models.some((model) => model.slug === resolvedProjectDefault.model),
            ),
        )?.selection ?? null);
  const selection =
    realProjectDefault ??
    configuredOptions.find((option) => option.isDefault && !option.isLegacy)?.selection ??
    configuredOptions.find((option) => !option.isLegacy)?.selection ??
    null;
  if (selection === null) {
    throw new VoiceMobileStartDefaultsUnavailableError("model-unavailable");
  }
  return selection;
}

async function readProjectFileDefault(
  dependencies: VoiceMobileStartDefaultsResolverDependencies,
  project: EnvironmentProject,
): Promise<ThreadEnvMode | null> {
  if (project.defaultThreadEnvMode != null) return null;

  try {
    const result = await dependencies.readProjectFile({
      environmentId: project.environmentId,
      input: {
        cwd: project.workspaceRoot,
        relativePath: T3_PROJECT_FILE_NAME,
      },
    });
    if (result === null || result.truncated) return null;
    return parseT3ProjectFile(result.contents)?.defaultThreadEnvMode ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves only durable project/environment defaults for a voice-created task.
 * Mobile composer drafts and the current route are deliberately not inputs.
 */
export function createVoiceMobileStartDefaultsResolver(
  dependencies: VoiceMobileStartDefaultsResolverDependencies,
): VoiceSupervisorRepositoryDependencies["resolveStartThreadDefaults"] {
  return async ({ project }) => {
    const config = await dependencies.readTargetServerConfig(project.environmentId);
    if (config === null) {
      throw new VoiceMobileStartDefaultsUnavailableError("target-environment-unavailable");
    }

    const projectFileMode = await readProjectFileDefault(dependencies, project);
    const workspaceMode = resolveDefaultThreadEnvMode({
      projectSetting: project.defaultThreadEnvMode,
      projectFile: projectFileMode,
      globalDefault: config.settings.defaultThreadEnvMode,
    });
    const modelSelection = resolveModelSelection(config, project.defaultModelSelection);

    if (workspaceMode === "local") {
      return {
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspace: {
          mode: "local",
          branch: null,
          worktreePath: null,
        },
      };
    }

    let refs: Pick<VcsListRefsResult, "isRepo" | "refs">;
    try {
      refs = await dependencies.listRefs({
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot, limit: 100 },
      });
    } catch {
      throw new VoiceMobileStartDefaultsUnavailableError("git-unavailable");
    }
    const baseBranch =
      refs.refs.find((ref) => ref.isDefault)?.name ??
      refs.refs.find((ref) => ref.current && ref.isRemote !== true)?.name ??
      null;
    if (!refs.isRepo || baseBranch === null) {
      throw new VoiceMobileStartDefaultsUnavailableError("worktree-base-unavailable");
    }

    return {
      modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      workspace: {
        mode: "worktree",
        baseBranch,
        startFromOrigin: config.settings.newWorktreesStartFromOrigin,
      },
    };
  };
}
