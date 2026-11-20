import { useAtomValue } from "@effect/atom-react";

import { projectBoardsAtom } from "../state/boards";
import { environmentProjects } from "../state/projects";
import type { ValidBoard } from "../store/boardFiles";
import { BoardScreen } from "./BoardScreen";
import { Viewport } from "./Viewport";

/** The board the app has open, or the empty canvas while it is not ready. */
export function OpenedBoard({ projectId, folder }: { projectId: string; folder: string }) {
  const project = useAtomValue(environmentProjects.projectsAtom).find(
    (entry) => entry.id === projectId,
  );
  const boards = useAtomValue(projectBoardsAtom(projectId));
  const listed: ValidBoard | undefined =
    boards.status === "ready"
      ? boards.boards.find(
          (entry): entry is ValidBoard =>
            entry.ok && entry.folder === folder && !entry.board.archived,
        )
      : undefined;
  if (project === undefined || listed === undefined) return <Viewport />;
  return <BoardScreen key={`${projectId}/${folder}`} project={project} listed={listed} />;
}
