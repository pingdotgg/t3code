import { useAtomValue } from "@effect/atom-react";

import { OrchestratorPanel } from "../chat/OrchestratorPanel";
import { projectBoardsAtom } from "../state/boards";
import { environmentProjects } from "../state/projects";
import type { ValidBoard } from "../store/boardFiles";
import { CARD_HEIGHT, CARD_WIDTH, OrchestratorCard } from "./OrchestratorCard";
import { Viewport } from "./Viewport";

const CONTENT = { x: 40, y: 40, width: CARD_WIDTH, height: CARD_HEIGHT };

/** One board: its orchestrator card on the canvas, and the orchestrator's panel beside it. */
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
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <Viewport content={CONTENT}>
          <OrchestratorCard project={project} listed={listed} />
        </Viewport>
      </div>
      <OrchestratorPanel key={`${projectId}/${folder}`} project={project} listed={listed} />
    </div>
  );
}
