import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type {
  CommandId,
  EnvironmentId,
  OrchestrationCommand,
  ProjectId,
  SourceControlDiscoveryResult,
  SourceControlProviderKind,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import {
  ensureBrowseDirectoryPath,
  findProjectByPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../state/projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

export type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "github-enterprise" | "gitlab" | "bitbucket" | "azure-devops"
>;
export type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

export interface AddProjectRemoteTarget {
  readonly id: string;
  readonly source: AddProjectRemoteSource;
  readonly host: string | null;
}

export function canCreateProjectInEnvironment(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export type AddProjectRemoteSourceReadiness = ReadonlyMap<
  string,
  { readonly ready: boolean; readonly hint: string | null }
>;

export type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

export function addProjectRemoteSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "github-enterprise":
      return "GitHub Enterprise";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

export function addProjectRemoteSourcePathHint(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "owner/repo";
    case "github-enterprise":
      return "owner/repo";
    case "gitlab":
      return "group/project";
    case "bitbucket":
      return "workspace/repository";
    case "azure-devops":
      return "project/repository";
    case "url":
      return "URL";
  }
}

export function addProjectRemoteSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

const URL_TARGET: AddProjectRemoteTarget = { id: "url", source: "url", host: null };

const BASE_PROVIDER_KINDS: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];

const BASE_PROVIDER_TARGETS: ReadonlyArray<AddProjectRemoteTarget> = BASE_PROVIDER_KINDS.map(
  (kind) => ({ id: kind, source: kind, host: null }),
);

export function buildAddProjectRemoteTargets(
  discovery: SourceControlDiscoveryResult | null,
): ReadonlyArray<AddProjectRemoteTarget> {
  if (!discovery) return [URL_TARGET, ...BASE_PROVIDER_TARGETS];
  return [
    URL_TARGET,
    ...discovery.sourceControlProviders.flatMap((provider) =>
      provider.kind === "unknown"
        ? []
        : [
            {
              id: provider.id,
              source: provider.kind,
              // Only an enterprise target needs to pin a host; the rest keep
              // their requests host-free the way they always were.
              host: provider.kind === "github-enterprise" ? Option.getOrNull(provider.host) : null,
            },
          ],
    ),
  ];
}

export function addProjectRemoteTargetLabel(target: AddProjectRemoteTarget): string {
  if (target.source === "github-enterprise" && target.host) {
    return target.host;
  }
  return addProjectRemoteSourceLabel(target.source);
}

export function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
  targets: ReadonlyArray<AddProjectRemoteTarget>,
): ReadonlyArray<AddProjectRemoteTarget> {
  return Arr.sort(
    targets.filter((target) => target.source !== "url"),
    Order.mapInput(
      Order.Struct({
        ready: Order.flip(Order.Boolean),
        label: Order.String,
      }),
      (target: AddProjectRemoteTarget) => ({
        ready: addProjectRemoteTargetReadiness(readinessBySource, target.id).ready,
        label: addProjectRemoteTargetLabel(target),
      }),
    ),
  );
}

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const readiness = new Map<string, { ready: boolean; hint: string | null }>([
    ["url", { ready: true, hint: null }],
  ]);
  if (!discovery) return readiness;

  for (const provider of discovery.sourceControlProviders) {
    if (provider.kind === "unknown") continue;
    if (provider.status !== "available") {
      readiness.set(provider.id, { ready: false, hint: provider.installHint });
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness.set(provider.id, {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Source Control settings for setup guidance.`,
      });
      continue;
    }
    readiness.set(provider.id, { ready: true, hint: null });
  }
  return readiness;
}

export function addProjectRemoteTargetReadiness(
  readiness: AddProjectRemoteSourceReadiness,
  targetId: string,
): { readonly ready: boolean; readonly hint: string | null } {
  return (
    readiness.get(targetId) ?? {
      ready: false,
      hint: "Provider status unavailable. Open Source Control settings and rescan.",
    }
  );
}

export function getAddProjectInitialQuery(baseDirectory: string | null | undefined): string {
  const trimmed = baseDirectory?.trim() ?? "";
  return trimmed.length === 0 ? "~/" : ensureBrowseDirectoryPath(trimmed);
}

export function resolveAddProjectPath(input: {
  readonly rawPath: string;
  readonly currentProjectCwd?: string | null;
  readonly platform: string;
}): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  const rawPath = input.rawPath.trim();
  if (rawPath.length === 0) {
    return { ok: false, error: "Enter a project path." };
  }
  if (isUnsupportedWindowsProjectPath(rawPath, input.platform)) {
    return { ok: false, error: "Windows-style paths are only supported on Windows environments." };
  }
  if (isExplicitRelativeProjectPath(rawPath) && !input.currentProjectCwd) {
    return { ok: false, error: "Relative paths require an active project in this environment." };
  }
  const path = resolveProjectPathForDispatch(rawPath, input.currentProjectCwd);
  return path.length === 0 ? { ok: false, error: "Enter a project path." } : { ok: true, path };
}

export function findExistingAddProject(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId;
  readonly path: string;
}): EnvironmentProject | null {
  return (
    findProjectByPath(
      input.projects.filter((project) => project.environmentId === input.environmentId),
      input.path,
    ) ?? null
  );
}

export function buildProjectCreateCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly createdAt: string;
}): Extract<OrchestrationCommand, { type: "project.create" }> {
  return {
    type: "project.create",
    commandId: input.commandId,
    projectId: input.projectId,
    title: inferProjectTitleFromPath(input.workspaceRoot),
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: null,
    createdAt: input.createdAt,
  };
}
