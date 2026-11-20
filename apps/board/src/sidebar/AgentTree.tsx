import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useMemo, useState } from "react";

import { type AgentNode, agentTree } from "../state/boardModel";
import { useDriverOf, useThreadFamily } from "../state/family";
import type { ValidBoard } from "../store/boardFiles";
import { AgentBranch, chipIndent, plural } from "./AgentBranch";
import { CountChip } from "./CountChip";

const countNodes = (nodes: ReadonlyArray<AgentNode>): { total: number; working: number } =>
  nodes.reduce(
    (sum, node) => {
      const below = countNodes(node.children);
      return {
        total: sum.total + 1 + below.total,
        working: sum.working + (node.agent.runState === "working" ? 1 : 0) + below.working,
      };
    },
    { total: 0, working: 0 },
  );

/** A board's agents under its row, as a tree by who started whom. */
export function BoardAgents({
  project,
  listed,
  depth,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
  depth: number;
}) {
  const { board } = listed;
  const family = useThreadFamily(project.environmentId, board.orchestratorThreadId);
  const driverOf = useDriverOf();
  const tree = useMemo(
    () =>
      board.orchestratorThreadId === null
        ? []
        : agentTree({ family, orchestratorThreadId: board.orchestratorThreadId, driverOf }),
    [family, board.orchestratorThreadId, driverOf],
  );
  const [open, setOpen] = useState(true);
  const { total, working } = countNodes(tree);
  if (total === 0) return null;
  return (
    <>
      <div className="py-0.5" style={{ paddingLeft: chipIndent(depth) }}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${board.name} agents`}
          onClick={() => setOpen((value) => !value)}
        >
          <CountChip label={plural(total, "agent", "agents")} active={working} open={open} />
        </button>
      </div>
      {open &&
        tree.map((node) => (
          <AgentBranch
            key={node.agent.threadId}
            project={project}
            folder={listed.folder}
            node={node}
            depth={depth + 1}
          />
        ))}
    </>
  );
}
