import { useAtomValue } from "@effect/atom-react";

import { EmptyFiles } from "../files/EmptyFiles";
import { lastOpenedBoardAtom, projectBoardsAtom } from "../state/boards";
import { environmentProjects } from "../state/projects";
import type { ValidBoard } from "../store/boardFiles";
import { BoardChanges } from "./BoardChanges";

/** The Source Control tab: the open board's project and ticket worktrees as roots, and the changes of the chosen one. */
export function ChangesPanel() {
  const opened = useAtomValue(lastOpenedBoardAtom);
  const project = useAtomValue(environmentProjects.projectsAtom).find(
    (entry) => entry.id === opened?.projectId,
  );
  const boards = useAtomValue(projectBoardsAtom(opened?.projectId ?? ""));
  const listed: ValidBoard | undefined =
    opened !== null && boards.status === "ready"
      ? boards.boards.find(
          (entry): entry is ValidBoard =>
            entry.ok && entry.folder === opened.folder && !entry.board.archived,
        )
      : undefined;
  if (project === undefined || listed === undefined)
    return <EmptyFiles>Open a board to review its changes.</EmptyFiles>;
  return <BoardChanges key={`${project.id}/${listed.folder}`} project={project} listed={listed} />;
}
