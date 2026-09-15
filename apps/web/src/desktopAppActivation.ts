import type {
  DesktopAppActivationFailure,
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
  DesktopAppOpenThreadRequest,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
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

/**
 * Minimal view of an existing thread the activation handler needs. The real
 * coordinator projects `readThreadShell` into this shape so the handler stays
 * testable and provider-agnostic.
 */
export interface DesktopAppActivationThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
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
  /**
   * The following are only needed for open-thread. They are optional so older
   * callers and tests keep compiling, but open-thread fails safely when any is
   * absent rather than guessing.
   */
  readonly readThreadShell?:
    | ((ref: ScopedThreadRef) => DesktopAppActivationThread | null)
    | undefined;
  readonly navigateToThread?: ((ref: ScopedThreadRef) => Promise<void>) | undefined;
  readonly isThreadRouteActive?: ((ref: ScopedThreadRef) => boolean) | undefined;
  readonly isRequestActive?: ((requestId: string) => Promise<boolean>) | undefined;
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

function resolveOpenableThread(
  request: DesktopAppOpenThreadRequest,
  ref: ScopedThreadRef,
  readThreadShell: (ref: ScopedThreadRef) => DesktopAppActivationThread | null,
): DesktopAppActivationThread | null {
  const thread = readThreadShell(ref);
  if (thread === null) return null;
  // The shell lookup is already keyed by environment, but validate the
  // reference explicitly so a mismatched or stale cache entry can never be
  // reported as the requested thread.
  if (thread.environmentId !== request.environmentId || thread.threadId !== request.threadId) {
    return null;
  }
  // Archived threads are not openable and are never unarchived by activation.
  if (thread.archivedAt !== null) return null;
  return thread;
}

async function handleOpenWorkspaceRequest(
  request: Extract<DesktopAppActivationRequest, { type: "open-workspace" }>,
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

async function handleOpenThreadRequest(
  request: DesktopAppOpenThreadRequest,
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

  // No silent substitution: a request for a non-primary environment is
  // unavailable, not redirected to the primary one.
  if (request.environmentId !== target.environmentId) {
    return failure(
      request.requestId,
      "environment-unavailable",
      "The requested environment is not the desktop app's primary environment.",
    );
  }

  const { isRequestActive, readThreadShell, navigateToThread, isThreadRouteActive } = dependencies;
  if (
    isRequestActive === undefined ||
    readThreadShell === undefined ||
    navigateToThread === undefined ||
    isThreadRouteActive === undefined
  ) {
    return failure(
      request.requestId,
      "renderer-unavailable",
      "The desktop app cannot open an existing thread.",
    );
  }

  const ref: ScopedThreadRef = {
    environmentId: request.environmentId,
    threadId: request.threadId,
  };

  // The activity probes, the thread read and the navigation all cross the IPC
  // boundary, so any of them can reject when the desktop bridge is torn down.
  // Catch once and answer with a normal failure: a rejected promise makes the
  // coordinator drop the response and leaves the broker waiting for timeout.
  try {
    const thread = resolveOpenableThread(request, ref, readThreadShell);
    if (thread === null) {
      return failure(
        request.requestId,
        "thread-not-found",
        "The requested thread does not exist in the desktop app.",
      );
    }

    if (!(await isRequestActive(request.requestId))) {
      return failure(
        request.requestId,
        "request-superseded",
        "The desktop app request is no longer active.",
      );
    }

    // Re-read immediately before navigating: the first read may have raced a
    // delete or archive, and opening a gone thread would be a false success.
    if (resolveOpenableThread(request, ref, readThreadShell) === null) {
      return failure(
        request.requestId,
        "thread-not-found",
        "The requested thread does not exist in the desktop app.",
      );
    }

    await navigateToThread(ref);

    // A resolved navigate() promise is not proof of success by itself; also do
    // not acknowledge a request that stopped being active mid-navigation.
    if (!(await isRequestActive(request.requestId))) {
      return failure(
        request.requestId,
        "request-superseded",
        "The desktop app request is no longer active.",
      );
    }

    if (!isThreadRouteActive(ref)) {
      return failure(request.requestId, "thread-open-failed", "T3 Code could not open the thread.");
    }

    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      environmentId: request.environmentId,
      projectId: thread.projectId,
      threadId: request.threadId,
    };
  } catch {
    // Never leak the raw dependency error: the CLI needs a stable code, and a
    // torn-down bridge message is not actionable.
    return failure(request.requestId, "thread-open-failed", "T3 Code could not open the thread.");
  }
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppActivationRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  if (request.type === "open-thread") {
    return handleOpenThreadRequest(request, dependencies);
  }
  return handleOpenWorkspaceRequest(request, dependencies);
}
