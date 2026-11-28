import type {
  DesktopAppActivationFailure,
  DesktopAppActivationResponse,
  DesktopAppOpenWorkspaceRequest,
  DesktopAppPairEnvironmentRequest,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";

export interface DesktopAppActivationProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface DesktopAppActivationTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: ExecutionEnvironmentPlatformOs;
}

export interface DesktopAppActivationDependencies {
  readonly getTarget: () => DesktopAppActivationTarget | null;
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

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return { version: 1, requestId, ok: false, code, message };
}

function desktopPlatformToEnvironmentOs(
  platform: DesktopAppOpenWorkspaceRequest["platform"],
): ExecutionEnvironmentPlatformOs {
  return platform === "win32" ? "windows" : platform;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppOpenWorkspaceRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  const target = dependencies.getTarget();
  if (target === null) {
    return failure(
      request.requestId,
      "environment-unavailable",
      "The desktop app's primary local environment is not connected.",
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

export interface DesktopAppPairDependencies {
  /** Every environment the app has saved, including this machine's own. */
  readonly savedEnvironmentIds: () => ReadonlySet<EnvironmentId>;
  /** Pairs and saves the backend, resolving with its environment id. */
  readonly pair: (pairingUrl: string) => Promise<EnvironmentId>;
}

/**
 * `t3 app --pair` already proved it runs as this user on this machine, so unlike a
 * `t3code://pair` link it saves the backend without asking first.
 */
export async function handleDesktopAppPairRequest(
  request: DesktopAppPairEnvironmentRequest,
  dependencies: DesktopAppPairDependencies,
): Promise<DesktopAppActivationResponse> {
  const savedBefore = dependencies.savedEnvironmentIds();
  let environmentId: EnvironmentId;
  try {
    environmentId = await dependencies.pair(request.pairingUrl);
  } catch (error) {
    return failure(
      request.requestId,
      "pairing-failed",
      errorMessage(error, "T3 Code could not add the backend."),
    );
  }
  // The pairing URL names an address, not an environment, so a saved one only shows once paired.
  if (savedBefore.has(environmentId)) {
    return failure(
      request.requestId,
      "environment-already-saved",
      "That backend is already saved in T3 Code.",
    );
  }
  return { version: 1, requestId: request.requestId, ok: true, environmentId };
}
