import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { MessageCircleQuestion } from "lucide-react";
import { useContext, useState } from "react";

import { type AgentNode, type RunState } from "../state/boardModel";
import { peekAtom } from "../state/boardUi";
import { openBoard } from "../state/boards";
import { ProviderGlyph } from "../usage/ProviderGlyph";
import { CountChip } from "./CountChip";
import { SidebarRow } from "./SidebarRow";

// Lines a chip up with the title of the row above it: the row's padding, its indent steps, an icon, and the gap.
const BASE_PX = 8;
const STEP_PX = 14;
export const chipIndent = (depth: number) => BASE_PX + depth * STEP_PX + 24;

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const DOT = {
  working: { color: "bg-emerald-400", label: "Working" },
  waiting: { color: "bg-amber-400", label: "Waiting" },
  idle: { color: "bg-faint", label: "Idle" },
  failed: { color: "bg-red-400", label: "Failed" },
  stopped: { color: "bg-faint", label: "Stopped" },
} as const satisfies Record<RunState, { color: string; label: string }>;

/** One agent's row, and under it a count chip that folds its children. */
export function AgentBranch({
  project,
  folder,
  node,
  depth,
}: {
  project: EnvironmentProject;
  folder: string;
  node: AgentNode;
  depth: number;
}) {
  const registry = useContext(RegistryContext);
  const [open, setOpen] = useState(true);
  const { agent } = node;
  const dot = DOT[agent.runState];
  return (
    <>
      <SidebarRow
        depth={depth}
        icon={<ProviderGlyph driver={agent.driver ?? ""} />}
        title={agent.title}
        label={`${agent.title}, ${dot.label.toLowerCase()}`}
        onClick={() => {
          void openBoard(registry, { projectId: project.id, folder });
          registry.set(peekAtom, { threadId: agent.threadId, ticketKey: agent.ticketKey });
        }}
        trailing={
          <>
            {agent.pendingRequest && (
              <MessageCircleQuestion
                className="size-3.5 text-amber-300"
                aria-label="Waiting on you"
              />
            )}
            <span
              role="img"
              aria-label={dot.label}
              className={`size-2 rounded-full ${dot.color}`}
            />
          </>
        }
      />
      {node.children.length > 0 && (
        <>
          <div className="py-0.5" style={{ paddingLeft: chipIndent(depth) }}>
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${agent.title} children`}
              onClick={() => setOpen((value) => !value)}
            >
              <CountChip
                label={plural(node.children.length, "child", "children")}
                active={node.working}
                open={open}
              />
            </button>
          </div>
          {open &&
            node.children.map((child) => (
              <AgentBranch
                key={child.agent.threadId}
                project={project}
                folder={folder}
                node={child}
                depth={depth + 1}
              />
            ))}
        </>
      )}
    </>
  );
}
