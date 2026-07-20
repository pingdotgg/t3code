import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
}

interface DraftThreadContextLike extends ThreadContextLike {
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
}

type NewThreadHandler = (
  projectRef: ScopedProjectRef,
  options?: {
    branch?: string | null;
    worktreePath?: string | null;
    envMode?: DraftThreadEnvMode;
    startFromOrigin?: boolean;
  },
) => Promise<void>;

type NewThreadOptions = NonNullable<Parameters<NewThreadHandler>[1]>;

interface NewThreadDefaults {
  readonly envMode: DraftThreadEnvMode;
  readonly newWorktreesStartFromOrigin: boolean;
}

const MAIN_CHECKOUT_RESOLUTION_TIMEOUT_MS = 500;

export interface ChatThreadActionContext {
  readonly activeDraftThread: DraftThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
  readonly defaultThreadEnvMode?: DraftThreadEnvMode;
  readonly defaultNewWorktreesStartFromOrigin?: boolean;
  readonly resolveNewThreadDefaults?: (
    projectRef: ScopedProjectRef,
  ) => NewThreadDefaults | Promise<NewThreadDefaults>;
  readonly defaultMainCheckout?: {
    readonly branch: string;
    readonly path: string | null;
  } | null;
  readonly resolveDefaultMainCheckout?: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly branch: string; readonly path: string | null } | null | undefined>;
}

async function resolveThreadDefaults(
  context: ChatThreadActionContext,
  projectRef: ScopedProjectRef,
): Promise<NewThreadDefaults | null> {
  if (context.resolveNewThreadDefaults) {
    try {
      return await context.resolveNewThreadDefaults(projectRef);
    } catch {
      // Fall through to the captured defaults so thread creation remains available.
    }
  }
  if (context.defaultThreadEnvMode === undefined) return null;
  return {
    envMode: context.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: context.defaultNewWorktreesStartFromOrigin ?? false,
  };
}

async function resolveMainCheckout(
  context: ChatThreadActionContext,
  projectRef: ScopedProjectRef,
): Promise<{
  readonly branch: string;
  readonly path: string | null;
} | null> {
  if (!context.resolveDefaultMainCheckout) {
    return context.defaultMainCheckout ?? null;
  }
  let timeout: number | undefined;
  try {
    return (
      (await Promise.race([
        context.resolveDefaultMainCheckout(projectRef),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(resolve, MAIN_CHECKOUT_RESOLUTION_TIMEOUT_MS);
        }),
      ])) ??
      context.defaultMainCheckout ??
      null
    );
  } catch {
    return context.defaultMainCheckout ?? null;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

function buildContextualThreadOptions(context: ChatThreadActionContext): NewThreadOptions {
  return {
    branch: context.activeThread?.branch ?? context.activeDraftThread?.branch ?? null,
    worktreePath:
      context.activeThread?.worktreePath ?? context.activeDraftThread?.worktreePath ?? null,
    envMode:
      context.activeDraftThread?.envMode ??
      (context.activeThread?.worktreePath ? "worktree" : "local"),
    ...(context.activeDraftThread
      ? { startFromOrigin: context.activeDraftThread.startFromOrigin }
      : {}),
  };
}

export async function startNewThreadInProjectFromContext(
  context: ChatThreadActionContext,
  projectRef: ScopedProjectRef,
): Promise<void> {
  const defaults = await resolveThreadDefaults(context, projectRef);
  if (defaults === null) {
    await context.handleNewThread(projectRef);
    return;
  }

  const threadEnvMode = defaults.envMode;
  const mainCheckout = await resolveMainCheckout(context, projectRef);
  await context.handleNewThread(projectRef, {
    branch: mainCheckout?.branch ?? null,
    worktreePath: threadEnvMode === "local" ? (mainCheckout?.path ?? null) : null,
    envMode: threadEnvMode,
    startFromOrigin: resolveNewDraftStartFromOrigin({
      envMode: threadEnvMode,
      newWorktreesStartFromOrigin: defaults.newWorktreesStartFromOrigin,
    }),
  });
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await startNewThreadInProjectFromContext(context, projectRef);
  return true;
}

export async function startNewThreadInSameWorktreeFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef, buildContextualThreadOptions(context));
  return true;
}

export async function startNewLocalThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  const mainCheckout = await resolveMainCheckout(context, projectRef);

  await context.handleNewThread(projectRef, {
    branch: mainCheckout?.branch ?? null,
    worktreePath: mainCheckout?.path ?? null,
    envMode: "local",
    startFromOrigin: false,
  });
  return true;
}
