import { useAtomValue } from "@effect/atom-react";
import { lastOpenedBoardAtom, projectBoardsAtom } from "../state/boards";
import { environmentProjects } from "../state/projects";
import type { ValidBoard } from "../store/boardFiles";
import { BoardFiles } from "./BoardFiles";
import { EmptyFiles } from "./EmptyFiles";

/** The files tab: the open board's project and ticket worktrees, a tree of the chosen root, and the file picked from it. */
export function FilesPanel() {
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
    return <EmptyFiles>Open a board to browse its files.</EmptyFiles>;
  return <BoardFiles project={project} listed={listed} />;
}
