import type { DraftId } from "../composerDraftStore.ts";

export type NewThreadPresentation =
  | { readonly kind: "expanded-draft"; readonly draftId: DraftId }
  | { readonly kind: "draft-route"; readonly draftId: DraftId; readonly replace: boolean }
  | { readonly kind: "none" };

/**
 * A board-owned create stays on the board, while every classic chat surface
 * keeps its existing route navigation. If the user leaves the board while an
 * async draft setup is in flight, respect that newer navigation instead of
 * leaving a sheet armed for the next board visit.
 */
export function resolveNewThreadPresentation(input: {
  readonly sourcePathname: string;
  readonly currentPathname: string;
  readonly draftId: DraftId;
  readonly replace: boolean;
}): NewThreadPresentation {
  if (input.sourcePathname !== "/board") {
    return { kind: "draft-route", draftId: input.draftId, replace: input.replace };
  }
  return input.currentPathname === "/board"
    ? { kind: "expanded-draft", draftId: input.draftId }
    : { kind: "none" };
}
