import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { BoardListEntry, ScopedProjectRef } from "@t3tools/contracts";

/**
 * Pure board-list slice. Re-homed from the deleted Zustand `store.ts` so the
 * per-project board list stays keyed by the environment-scoped project ref
 * (two environments can share a project id). Backed in the UI by the
 * `workflowEnvironment.listBoards` query atom; this module keeps the pure
 * keying/merge logic (and its test coverage) independent of the atom layer.
 */
export interface BoardListState {
  readonly boardsByScopedProjectKey: Record<string, ReadonlyArray<BoardListEntry>>;
}

export const emptyBoardListState: BoardListState = {
  boardsByScopedProjectKey: {},
};

export function applyBoardList(
  state: BoardListState,
  ref: ScopedProjectRef,
  entries: ReadonlyArray<BoardListEntry>,
): BoardListState {
  return {
    ...state,
    boardsByScopedProjectKey: {
      ...state.boardsByScopedProjectKey,
      [scopedProjectKey(ref)]: entries,
    },
  };
}

export function selectBoardsForProject(
  state: BoardListState,
  ref: ScopedProjectRef,
): ReadonlyArray<BoardListEntry> {
  return state.boardsByScopedProjectKey[scopedProjectKey(ref)] ?? [];
}
