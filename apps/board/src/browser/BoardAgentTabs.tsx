import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext } from "react";

import { Notice } from "../artifacts/Notice";
import { projectBoardsAtom } from "../state/boards";
import { useThreadFamily } from "../state/family";
import { AgentStream } from "./AgentStream";
import { panelAtom, selectAgentTab } from "./panel";
import { ThreadTabs } from "./ThreadTabs";

/** The browser tabs held by the board's orchestrator and every agent under it, and the picked tab's live view. */
export function BoardAgentTabs({
  environmentId,
  projectId,
  folder,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  folder: string;
}) {
  const registry = useContext(RegistryContext);
  const selected = useAtomValue(panelAtom).agentTab;
  const boards = useAtomValue(projectBoardsAtom(projectId));
  const listed =
    boards.status === "ready"
      ? boards.boards.find((entry) => entry.ok && entry.folder === folder)
      : undefined;
  const orchestrator = listed?.ok ? listed.board.orchestratorThreadId : null;
  const family = useThreadFamily(environmentId, orchestrator);
  if (boards.status !== "ready") return <Notice>Loading the board</Notice>;
  if (orchestrator === null) return <Notice>This board has no agents yet.</Notice>;
  const titles = new Map<string, string>([[orchestrator, "Orchestrator"]]);
  for (const row of family) titles.set(row.id, row.title);
  return (
    <>
      <div
        role="group"
        aria-label="Agent tabs"
        className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line p-1.5"
      >
        {[...titles].map(([threadId, title]) => (
          <ThreadTabs
            key={threadId}
            threadId={threadId}
            title={title}
            selected={selected}
            onSelect={(target) => selectAgentTab(registry, target)}
          />
        ))}
      </div>
      {selected === null ? (
        <Notice>Pick an agent tab to watch it.</Notice>
      ) : (
        <AgentStream
          key={`${selected.threadId}/${selected.tabId}`}
          environmentId={environmentId}
          target={selected}
        />
      )}
    </>
  );
}
