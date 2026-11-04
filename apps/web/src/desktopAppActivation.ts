import type {
  DesktopAppActivationFailure,
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export const desktopAppActivationPendingAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop:app-activation:pending"),
);

export interface DesktopAppActivationProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface DesktopAppActivationTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: ExecutionEnvironmentPlatformOs;
}

export function resolveDesktopActivationTarget(
  request: DesktopAppActivationRequest,
  primaryId: EnvironmentId | null,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly backendId: string | null;
    readonly connected: boolean;
    readonly platform: ExecutionEnvironmentPlatformOs | null;
  }>,
  bootstraps: ReadonlyArray<{ readonly id: string; readonly runningDistro?: string | null }>,
): DesktopAppActivationTarget | null {
  if (request.wslDistro !== undefined) {
    return findWslActivationTarget(request.wslDistro, environments, bootstraps);
  }
  const primary = environments.find((environment) => environment.environmentId === primaryId);
  return primary?.connected && primary.platform !== null
    ? { environmentId: primary.environmentId, platform: primary.platform }
    : null;
}

export function openedProjectDraft(
  project: ScopedProjectRef,
  draft: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly promotedTo?: ScopedThreadRef | null;
  } | null,
): { readonly threadId: ThreadId } | null {
  return draft?.environmentId === project.environmentId &&
    draft.projectId === project.projectId &&
    draft.promotedTo == null
    ? { threadId: draft.threadId }
    : null;
}

export interface DesktopAppActivationDependencies {
  readonly getTarget: (
    request: DesktopAppActivationRequest,
  ) => DesktopAppActivationTarget | null | Promise<DesktopAppActivationTarget | null>;
  readonly waitForSnapshot: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly findProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => DesktopAppActivationProject | null;
  readonly createProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => Promise<ProjectId>;
  readonly waitForProject: (projectRef: ScopedProjectRef) => Promise<void>;
  readonly openThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
}

export function findWslActivationTarget(
  distro: string,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly backendId: string | null;
    readonly connected: boolean;
    readonly platform: ExecutionEnvironmentPlatformOs | null;
  }>,
  bootstraps: ReadonlyArray<{ readonly id: string; readonly runningDistro?: string | null }>,
): DesktopAppActivationTarget | null {
  const target = environments.find((environment) => {
    const bootstrap = bootstraps.find((entry) => entry.id === environment.backendId);
    return (
      environment.connected &&
      environment.platform !== null &&
      bootstrap?.runningDistro?.toLowerCase() === distro.toLowerCase()
    );
  });
  return target?.platform
    ? { environmentId: target.environmentId, platform: target.platform }
    : null;
}

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return { version: 1, requestId, ok: false, code, message };
}

function desktopPlatformToEnvironmentOs(
  platform: DesktopAppActivationRequest["platform"],
): ExecutionEnvironmentPlatformOs {
  return platform === "win32" ? "windows" : platform;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppActivationRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  const target = await dependencies.getTarget(request);
  if (target === null) {
    return failure(
      request.requestId,
      "environment-unavailable",
      request.wslDistro
        ? `The WSL environment for ${request.wslDistro} is not connected. Enable it in Settings → Sharing & access and try again.`
        : "The desktop app's primary local environment is not connected.",
    );
  }

  const requestPlatform = desktopPlatformToEnvironmentOs(request.platform);
  if (requestPlatform !== target.platform) {
    return failure(
      request.requestId,
      "platform-mismatch",
      `The command path is for ${requestPlatform}, but the desktop app's primary environment uses ${target.platform}. Cross-platform path mapping is not supported.`,
    );
  }

  if (!(await dependencies.waitForSnapshot(target.environmentId))) {
    return failure(
      request.requestId,
      "environment-unavailable",
      "The target environment is not ready. Try again.",
    );
  }

  let projectId = dependencies.findProject(target.environmentId, request.workspaceRoot)?.id ?? null;
  if (projectId === null) {
    try {
      projectId = await dependencies.createProject(target.environmentId, request.workspaceRoot);
      await dependencies.waitForProject({ environmentId: target.environmentId, projectId });
    } catch (error) {
      return failure(
        request.requestId,
        "project-create-failed",
        errorMessage(error, "T3 Code could not add the project."),
      );
    }
  }

  try {
    const opened = await dependencies.openThread({
      environmentId: target.environmentId,
      projectId,
    });
    if (opened === null) {
      return failure(
        request.requestId,
        "thread-open-failed",
        "T3 Code could not open a new thread for the project.",
      );
    }
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId,
      threadId: opened.threadId,
    };
  } catch (error) {
    return failure(
      request.requestId,
      "thread-open-failed",
      errorMessage(error, "T3 Code could not open a new thread for the project."),
    );
  }
}
