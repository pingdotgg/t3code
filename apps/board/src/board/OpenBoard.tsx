import { useAtomValue } from "@effect/atom-react";

import { lastOpenedBoardAtom } from "../state/boards";
import { OpenedBoard } from "./OpenedBoard";
import { Viewport } from "./Viewport";

/** The board the user last opened, or the empty canvas while none is open. */
export function OpenBoard() {
  const opened = useAtomValue(lastOpenedBoardAtom);
  return opened === null ? (
    <Viewport />
  ) : (
    <OpenedBoard projectId={opened.projectId} folder={opened.folder} />
  );
}
