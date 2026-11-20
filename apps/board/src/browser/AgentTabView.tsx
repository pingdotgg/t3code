import { useAtomValue } from "@effect/atom-react";

import { Notice } from "../artifacts/Notice";
import { lastOpenedBoardAtom } from "../state/boards";
import { engineEnvironmentIdAtom } from "../state/projects";
import { BoardAgentTabs } from "./BoardAgentTabs";

/** The browser tabs the open board's agents hold in the engine, and a live view of the one picked. */
export function AgentTabView() {
  const environmentId = useAtomValue(engineEnvironmentIdAtom);
  const opened = useAtomValue(lastOpenedBoardAtom);
  return (
    <div data-testid="agent-tabs" className="flex min-h-0 flex-1 flex-col">
      {environmentId === null ? (
        <Notice>Waiting for the engine.</Notice>
      ) : opened === null ? (
        <Notice>Open a board to see its agents' tabs.</Notice>
      ) : (
        <BoardAgentTabs
          environmentId={environmentId}
          projectId={opened.projectId}
          folder={opened.folder}
        />
      )}
    </div>
  );
}
