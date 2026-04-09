import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";

import type { DraftId } from "../composerDraftStore";

export type DiffSurfaceFocus =
  | { scope: "conversation" }
  | { scope: "turn"; turnId: TurnId; filePath?: string | undefined };

export type WorkspaceTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
      environmentId: ScopedThreadRef["environmentId"];
      threadId: ScopedThreadRef["threadId"];
    };

export type MainSurface = {
  id: "chat";
  input: WorkspaceTarget;
};

export type SecondarySurface = {
  id: "diff";
  input: {
    threadRef: ScopedThreadRef;
    focus: DiffSurfaceFocus;
  };
};

export type WorkspaceState = {
  version: 1;
  target: WorkspaceTarget;
  surfaces: {
    main: MainSurface;
    secondary: SecondarySurface | null;
  };
};

export function sameThreadRef(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  return left?.environmentId === right?.environmentId && left?.threadId === right?.threadId;
}

export function sameWorkspaceTarget(
  left: WorkspaceTarget | null | undefined,
  right: WorkspaceTarget | null | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "server" && right.kind === "server") {
    return sameThreadRef(left.threadRef, right.threadRef);
  }

  if (left.kind !== "draft" || right.kind !== "draft") {
    return false;
  }

  return (
    left.draftId === right.draftId &&
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId
  );
}

export function sameDiffSurfaceFocus(
  left: DiffSurfaceFocus | null | undefined,
  right: DiffSurfaceFocus | null | undefined,
): boolean {
  if (!left || !right || left.scope !== right.scope) {
    return false;
  }

  if (left.scope === "conversation" && right.scope === "conversation") {
    return true;
  }

  if (left.scope !== "turn" || right.scope !== "turn") {
    return false;
  }

  return left.turnId === right.turnId && left.filePath === right.filePath;
}

export function sameMainSurface(
  left: MainSurface | null | undefined,
  right: MainSurface | null | undefined,
): boolean {
  return Boolean(
    left && right && left.id === right.id && sameWorkspaceTarget(left.input, right.input),
  );
}

export function sameSecondarySurface(
  left: SecondarySurface | null | undefined,
  right: SecondarySurface | null | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.id === right.id &&
    sameThreadRef(left.input.threadRef, right.input.threadRef) &&
    sameDiffSurfaceFocus(left.input.focus, right.input.focus),
  );
}

export function sameWorkspaceState(
  left: WorkspaceState | null | undefined,
  right: WorkspaceState | null | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.version === right.version &&
    sameWorkspaceTarget(left.target, right.target) &&
    sameMainSurface(left.surfaces.main, right.surfaces.main) &&
    ((left.surfaces.secondary === null && right.surfaces.secondary === null) ||
      sameSecondarySurface(left.surfaces.secondary, right.surfaces.secondary)),
  );
}

export function createDefaultWorkspaceState(target: WorkspaceTarget): WorkspaceState {
  return {
    version: 1,
    target,
    surfaces: {
      main: {
        id: "chat",
        input: target,
      },
      secondary: null,
    },
  };
}
