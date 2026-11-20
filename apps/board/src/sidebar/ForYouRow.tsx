import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Inbox } from "lucide-react";
import { useContext } from "react";

import type { BoardOpenItems } from "../domain/forYou";
import { focusedCardAtom, forYouBoardsAtom } from "../state/forYou";
import { openBoard } from "../state/boards";
import { SidebarRow } from "./SidebarRow";

/** Opens the board that holds the item and marks the item's card there. */
export function showForYouCard(
  registry: Parameters<typeof openBoard>[0],
  board: Pick<BoardOpenItems, "projectId" | "folder" | "boardId">,
  cardId: string,
) {
  void openBoard(registry, { projectId: board.projectId, folder: board.folder });
  registry.set(focusedCardAtom, { boardId: board.boardId, cardId });
}

/** What waits on the user across every board. A press opens the board with the oldest open item. */
export function ForYouRow() {
  const registry = useContext(RegistryContext);
  const boards = useAtomValue(forYouBoardsAtom);
  const total = boards.reduce((sum, board) => sum + board.open.length, 0);
  const first = boards.find((board) => board.open.length > 0);
  return (
    <SidebarRow
      icon={<Inbox className="size-3.5" />}
      title="For you"
      label={`For you, ${total} open`}
      onClick={() => {
        const item = first?.open[0];
        if (first !== undefined && item !== undefined) showForYouCard(registry, first, item.id);
      }}
      trailing={
        <span
          data-testid="sidebar-foryou-count"
          className={
            total > 0
              ? "rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 font-semibold text-black"
              : "text-[11px] text-faint"
          }
        >
          {total}
        </span>
      }
    />
  );
}
