import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

/** Where a pinned drawer applies: one project, or every project in the environment. */
export type TerminalDrawerPinScope = "project" | "environment";
export type TerminalDrawerPinState = TerminalDrawerPinScope | "none";

export function projectTerminalPinKey(projectKey: string): string {
  return `project:${projectKey}`;
}

export function environmentTerminalPinKey(environmentId: EnvironmentId): string {
  return `environment:${environmentId}`;
}

/**
 * Drawer `terminal.toggle` targets for `threadRef` and why. An environment-wide
 * pin wins over a project pin; either wins over the thread's own drawer.
 * Right-panel terminals ignore pins and stay on the thread.
 */
export function resolveTerminalDrawer(input: {
  threadRef: ScopedThreadRef | null;
  /** The project's pinned thread, already checked to still exist in that project. */
  projectPinnedThreadRef: ScopedThreadRef | null;
  /** The environment's pinned thread, already checked to still exist. */
  environmentPinnedThreadRef: ScopedThreadRef | null;
}): { drawerRef: ScopedThreadRef | null; pinState: TerminalDrawerPinState } {
  const { threadRef } = input;
  if (threadRef === null) {
    return { drawerRef: null, pinState: "none" };
  }
  const environmentPinned = input.environmentPinnedThreadRef;
  if (environmentPinned !== null && environmentPinned.environmentId === threadRef.environmentId) {
    return { drawerRef: environmentPinned, pinState: "environment" };
  }
  const projectPinned = input.projectPinnedThreadRef;
  if (projectPinned !== null && projectPinned.environmentId === threadRef.environmentId) {
    return { drawerRef: projectPinned, pinState: "project" };
  }
  return { drawerRef: threadRef, pinState: "none" };
}

/** The pin button cycles off → this project → every project → off. */
export function nextTerminalDrawerPinState(
  current: TerminalDrawerPinState,
): TerminalDrawerPinState {
  switch (current) {
    case "none":
      return "project";
    case "project":
      return "environment";
    case "environment":
      return "none";
  }
}
