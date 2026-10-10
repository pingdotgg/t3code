import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type {
  CommandId,
  EnvironmentId,
  ProjectMutation,
  ProjectId,
  ServerConfig,
  SourceControlDiscoveryResult,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { newProjectFolderName } from "@t3tools/shared/path";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../state/projects.ts";
import type { EnvironmentProject } from "../state/models.ts";
import { sourceControlClients } from "../sourceControlClients.ts";
import type { SourceControlClientDefinition } from "../sourceControlClients.ts";

/** A host to clone from, or `url` for a pasted clone URL. */
export type AddProjectRemoteSource = SourceControlProviderKind | "url";

export function canCreateProjectInEnvironment(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

/**
 * The Scratch folder an environment offers threads without a project right
 * now, or null while it is not connected or has none.
 */
export function availableScratchWorkspaceRoot(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
  serverConfig: Pick<ServerConfig, "scratchWorkspaceRoot"> | null | undefined,
): string | null {
  return canCreateProjectInEnvironment(connectionPhase)
    ? (serverConfig?.scratchWorkspaceRoot ?? null)
    : null;
}

export interface AddProjectRemoteSourceReadinessEntry {
  readonly ready: boolean;
  readonly hint: string | null;
}

/** Whether each clone source can be used on an environment, and why not. */
export type AddProjectRemoteSourceReadiness = (
  source: AddProjectRemoteSource,
) => AddProjectRemoteSourceReadinessEntry;

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

/** The hosts the clone picker offers, in the order the built-in definitions list them. */
const ADD_PROJECT_REMOTE_PROVIDER_SOURCES: ReadonlyArray<SourceControlProviderKind> =
  sourceControlClients.definitions.map((definition) => definition.kind);

export function addProjectRemoteSourceLabel(source: AddProjectRemoteSource): string {
  return source === "url" ? "Git URL" : sourceControlClients.get(source).pickerLabel;
}

export function addProjectRemoteSourcePathHint(source: AddProjectRemoteSource): string {
  return source === "url" ? "URL" : sourceControlClients.get(source).repositoryPathHint;
}

export function addProjectRemoteSourceProvider(
  source: AddProjectRemoteSource,
): SourceControlProviderKind | null {
  return source === "url" ? null : source;
}

/** A clone source named in a route or link, or `url` for anything this client does not ship. */
export function parseAddProjectRemoteSource(
  value: string | null | undefined,
): AddProjectRemoteSource {
  return (value ? sourceControlClients.find(value)?.kind : undefined) ?? "url";
}

const GITHUB_REPOSITORY_SHORTHAND =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+(?:\.git)?$/;

/** Treat the common owner/repository shorthand as a public GitHub HTTPS URL. */
export function normalizePastedCloneUrl(input: string): string {
  const trimmed = input.trim();
  if (!GITHUB_REPOSITORY_SHORTHAND.test(trimmed)) return trimmed;
  const repository = trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
  return `https://github.com/${repository}`;
}

/** The clone URL for the transport the repository's host defaults to. */
export function getDefaultCloneUrl(
  repository: Pick<SourceControlRepositoryInfo, "provider" | "url" | "sshUrl">,
): string {
  return sourceControlClients.get(repository.provider).defaultCloneTransport === "https"
    ? repository.url
    : repository.sshUrl;
}

export function sortAddProjectProviderSources(
  readiness: AddProjectRemoteSourceReadiness,
): ReadonlyArray<SourceControlProviderKind> {
  return Arr.sort(
    ADD_PROJECT_REMOTE_PROVIDER_SOURCES,
    Order.mapInput(
      Order.Struct({
        ready: Order.flip(Order.Boolean),
        label: Order.String,
      }),
      (source: SourceControlProviderKind) => ({
        ready: readiness(source).ready,
        label: addProjectRemoteSourceLabel(source),
      }),
    ),
  );
}

const READY: AddProjectRemoteSourceReadinessEntry = { ready: true, hint: null };
const UNAVAILABLE: AddProjectRemoteSourceReadinessEntry = {
  ready: false,
  hint: "Provider status unavailable. Open Source Control settings and rescan.",
};

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const providerByKind = new Map(
    (discovery?.sourceControlProviders ?? []).map((provider) => [provider.kind, provider]),
  );
  return (source) => {
    if (source === "url") return READY;
    const provider = providerByKind.get(source);
    if (!provider) return UNAVAILABLE;
    if (provider.status !== "available") return { ready: false, hint: provider.installHint };
    if (provider.auth.status === "unauthenticated") {
      return {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Source Control settings for setup guidance.`,
      };
    }
    return READY;
  };
}

export function getAddProjectInitialQuery(baseDirectory: string | null | undefined): string {
  const trimmed = baseDirectory?.trim() ?? "";
  return trimmed.length === 0 ? "~/" : ensureBrowseDirectoryPath(trimmed);
}

/**
 * Folder name `git clone` would pick, from either a looked-up repository or a
 * pasted clone URL. Providers report `owner/repo`, Azure DevOps reports
 * `org/project/repo`, and a URL can arrive in any form: `https://host/owner/
 * repo.git`, `ssh://git@host:22/owner/repo`, `git@host:owner/repo.git`, with
 * or without a query, a fragment or a trailing slash. The repository is always
 * the last segment, minus the `.git` suffix.
 */
export function getCloneDirectoryName(repositoryOrRemoteUrl: string | null | undefined): string {
  const withoutQuery = (repositoryOrRemoteUrl ?? "").split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  // A remote URL carries a host before the repository path. The host is never
  // the repository, so a link that stops at the host, or at a port, names
  // nothing and the destination falls back to the browsed folder.
  const hasHost = schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  const pathPart = schemeIndex >= 0 ? withoutQuery.slice(schemeIndex + "://".length) : withoutQuery;
  const segments = pathPart.split(/[/\\:]+/).filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) {
    return "";
  }

  const lastSegment = segments.at(-1)?.trim() ?? "";
  // A port can only sit directly behind the authority, so it is a port only
  // when nothing follows it. Deeper segments are path, even when numeric: the
  // repository in `https://host/acme/123` really is named `123`.
  if (hasHost && segments.length === 2 && /^\d+$/.test(lastSegment)) {
    return "";
  }
  return lastSegment.endsWith(".git") ? lastSegment.slice(0, -".git".length) : lastSegment;
}

/**
 * Clone destination proposed for a directory: the directory the user picked
 * plus the repository folder inside it. Without a name the directory is the
 * destination, which is what the raw clone URL flow keeps doing.
 */
export function getCloneDestinationPath(
  directoryPath: string,
  directoryName: string | null | undefined,
): string {
  const name = directoryName?.trim() ?? "";
  if (name.length === 0) {
    return directoryPath;
  }
  return `${ensureBrowseDirectoryPath(directoryPath)}${name}`;
}

/**
 * Where `projects.createNew` will put a project named `name`. The server adds
 * `-2`, `-3`, ... when that folder is taken, so this is a preview.
 */
export function getNewProjectPathPreview(newProjectsRoot: string, name: string): string {
  return getCloneDestinationPath(newProjectsRoot, newProjectFolderName(name));
}

/** A host a new project can be published to, and who the repository goes under there. */
export interface NewProjectPublishTarget {
  readonly definition: SourceControlClientDefinition;
  /** Null lets the host's CLI place it under the signed-in user. */
  readonly owner: string | null;
}

/**
 * The hosts a new project can be published to on that environment, in definition order so
 * GitHub leads. A host is offered when it is ready and its account names where the repository
 * goes.
 */
export function getNewProjectPublishTargets(
  discovery: SourceControlDiscoveryResult | null,
): ReadonlyArray<NewProjectPublishTarget> {
  const readiness = buildAddProjectRemoteSourceReadiness(discovery);
  return sourceControlClients.definitions.flatMap((definition) => {
    if (!readiness(definition.kind).ready) return [];
    const provider = discovery?.sourceControlProviders.find(
      (candidate) => candidate.kind === definition.kind,
    );
    const placement = definition.newRepositoryOwner(
      provider ? Option.getOrNull(provider.auth.account) : null,
    );
    return placement === null ? [] : [{ definition, owner: placement.owner }];
  });
}

/** The chosen host's target, or the first one when the choice is not on offer. */
export function getNewProjectPublishTarget(
  targets: ReadonlyArray<NewProjectPublishTarget>,
  kind: SourceControlProviderKind | null,
): NewProjectPublishTarget | null {
  return targets.find((target) => target.definition.kind === kind) ?? targets[0] ?? null;
}

/** `owner/folder` for publishing a new project, or just the folder for the host to place. */
export function getNewProjectRepository(
  target: Pick<NewProjectPublishTarget, "owner">,
  workspaceRoot: string,
): string {
  const folderName = workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return target.owner ? `${target.owner}/${folderName}` : folderName;
}

/**
 * Destination query after choosing a directory while the clone folder is
 * pinned in the path input. Selecting an existing directory with the pinned
 * name uses that directory directly instead of producing `repo/repo`.
 */
export function getCloneDestinationBrowsePath(input: {
  readonly browseDirectoryPath: string;
  readonly selectedDirectoryName: string;
  readonly cloneDirectoryName: string;
  readonly caseSensitive: boolean;
}): string {
  const selectedDirectoryPath = appendBrowsePathSegment(
    input.browseDirectoryPath,
    input.selectedDirectoryName,
  );
  const selectedDirectoryMatches = input.caseSensitive
    ? input.selectedDirectoryName === input.cloneDirectoryName
    : input.selectedDirectoryName.toLowerCase() === input.cloneDirectoryName.toLowerCase();
  return selectedDirectoryMatches
    ? selectedDirectoryPath
    : getCloneDestinationPath(selectedDirectoryPath, input.cloneDirectoryName);
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
}): Extract<ProjectMutation, { type: "project.create" }> {
  return {
    type: "project.create",
    commandId: input.commandId,
    projectId: input.projectId,
    title: inferProjectTitleFromPath(input.workspaceRoot),
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: null,
  };
}
