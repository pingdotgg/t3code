import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import type { DraftId } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";

export type WorkspaceAxis = "x" | "y";
export type WorkspaceDirection = "left" | "right" | "up" | "down";
export type WorkspaceDropPlacement = "center" | "left" | "right" | "top" | "bottom";
export type WorkspaceLayoutEngine = "split";
export type WorkspaceSurfaceKind = "thread" | "terminal";
export type WorkspaceSplitSizingMode = "auto" | "manual";

export type ThreadSurfaceInput =
  | {
      scope: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      scope: "draft";
      draftId: DraftId;
      environmentId: EnvironmentId;
      threadId: ThreadId;
    };

export interface TerminalSurfaceInput {
  scope: "thread";
  threadRef: ScopedThreadRef;
  terminalId: string;
}

export type WorkspaceSurfaceInstance =
  | {
      id: string;
      kind: "thread";
      input: ThreadSurfaceInput;
    }
  | {
      id: string;
      kind: "terminal";
      input: TerminalSurfaceInput;
    };

export interface WorkspaceWindow {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export type WorkspacePlacementTarget =
  | {
      kind: "window";
      windowId: string;
      placement: WorkspaceDropPlacement;
    }
  | {
      kind: "tab";
      windowId: string;
      surfaceId: string;
    };

export type WorkspaceNode =
  | {
      id: string;
      kind: "window";
      windowId: string;
    }
  | {
      id: string;
      kind: "split";
      axis: WorkspaceAxis;
      childIds: string[];
      sizes: number[];
      sizingMode: WorkspaceSplitSizingMode;
    };

export interface WorkspaceDocument {
  version: 1;
  layoutEngine: WorkspaceLayoutEngine;
  rootNodeId: string | null;
  nodesById: Record<string, WorkspaceNode>;
  windowsById: Record<string, WorkspaceWindow>;
  surfacesById: Record<string, WorkspaceSurfaceInstance>;
  focusedWindowId: string | null;
  mobileActiveWindowId: string | null;
}

export function createEmptyWorkspaceDocument(): WorkspaceDocument {
  return {
    version: 1,
    layoutEngine: "split",
    rootNodeId: null,
    nodesById: {},
    windowsById: {},
    surfacesById: {},
    focusedWindowId: null,
    mobileActiveWindowId: null,
  };
}

export function normalizeWorkspaceSplitSizes(
  sizes: number[] | null | undefined,
  childCount: number,
): number[] {
  if (childCount <= 0) {
    return [];
  }

  const fallback = Array.from({ length: childCount }, () => 1 / childCount);
  if (!sizes || sizes.length !== childCount) {
    return fallback;
  }

  const finiteSizes = sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0));
  const total = finiteSizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) {
    return fallback;
  }

  return finiteSizes.map((size) => size / total);
}

export function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WorkspaceDocument>;
  return candidate.version === 1 && candidate.layoutEngine === "split";
}

export function sameThreadSurfaceInput(
  left: ThreadSurfaceInput | null | undefined,
  right: ThreadSurfaceInput | null | undefined,
): boolean {
  if (!left || !right || left.scope !== right.scope) {
    return false;
  }

  if (left.scope === "server" && right.scope === "server") {
    return (
      left.threadRef.environmentId === right.threadRef.environmentId &&
      left.threadRef.threadId === right.threadRef.threadId
    );
  }

  if (left.scope !== "draft" || right.scope !== "draft") {
    return false;
  }

  return (
    left.draftId === right.draftId &&
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId
  );
}

export function sameTerminalSurfaceInput(
  left: TerminalSurfaceInput | null | undefined,
  right: TerminalSurfaceInput | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.scope === right.scope &&
    left.threadRef.environmentId === right.threadRef.environmentId &&
    left.threadRef.threadId === right.threadRef.threadId &&
    left.terminalId === right.terminalId
  );
}

export function sameWorkspaceSurface(
  left: WorkspaceSurfaceInstance | null | undefined,
  right: WorkspaceSurfaceInstance | null | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "thread" && right.kind === "thread") {
    return sameThreadSurfaceInput(left.input, right.input);
  }

  if (left.kind === "terminal" && right.kind === "terminal") {
    return sameTerminalSurfaceInput(left.input, right.input);
  }

  return false;
}

export function routeTargetForSurface(
  surface: WorkspaceSurfaceInstance | null | undefined,
): ThreadRouteTarget | null {
  if (!surface) {
    return null;
  }

  if (surface.kind === "thread") {
    if (surface.input.scope === "server") {
      return {
        kind: "server",
        threadRef: surface.input.threadRef,
      };
    }

    return {
      kind: "draft",
      draftId: surface.input.draftId,
    };
  }

  return {
    kind: "server",
    threadRef: surface.input.threadRef,
  };
}

export function normalizeThreadSurfaceInput(input: ThreadSurfaceInput): ThreadSurfaceInput {
  if (input.scope === "server") {
    return input;
  }

  return {
    scope: "draft",
    draftId: input.draftId,
    environmentId: input.environmentId,
    threadId: input.threadId,
  };
}

export function serverThreadSurfaceInput(threadRef: ScopedThreadRef): ThreadSurfaceInput {
  return {
    scope: "server",
    threadRef,
  };
}

export function draftThreadSurfaceInput(input: {
  draftId: DraftId;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}): ThreadSurfaceInput {
  return {
    scope: "draft",
    draftId: input.draftId,
    environmentId: input.environmentId,
    threadId: input.threadId,
  };
}

export function terminalSurfaceInput(
  threadRef: ScopedThreadRef,
  terminalId: string,
): TerminalSurfaceInput {
  return {
    scope: "thread",
    threadRef,
    terminalId,
  };
}
