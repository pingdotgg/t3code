import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ThreadId } from "@t3tools/contracts";

import type { ValidBoard } from "../store/boardFiles";
import { Conversation } from "./Conversation";
import { PanelHeader } from "./PanelHeader";
import { StartOrchestrator } from "./StartOrchestrator";

/** The chat with a board's orchestrator, in the side panel. */
export function OrchestratorPanel({
  project,
  listed,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
}) {
  const threadId = listed.board.orchestratorThreadId;
  return (
    <aside
      aria-label="Orchestrator"
      className="flex min-h-0 w-[420px] shrink-0 flex-col border-l border-line bg-sidebar"
    >
      {threadId === null ? (
        <>
          <PanelHeader title={listed.board.name} status="Not started" />
          <StartOrchestrator project={project} listed={listed} />
        </>
      ) : (
        <Conversation project={project} listed={listed} threadId={ThreadId.make(threadId)} />
      )}
    </aside>
  );
}
