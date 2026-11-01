import {
  CHILD_STATUS_BUCKETS,
  type ChildStatusBucket,
  type ChildStatusCounts,
} from "@t3tools/client-runtime/state/child-status-counts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { McpGatewayProfile } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { CHILD_STATUS_COLORS } from "../ChildStatusCounts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentIcon } from "./AgentIcon";
import { agentThreadStatusLabel, runAgentName, type AgentThreadStatus } from "./agents.logic";

export interface AgentChildAvatarEntry {
  readonly thread: EnvironmentThreadShell;
  readonly status: AgentThreadStatus;
  readonly bucket: ChildStatusBucket;
  readonly updatedAt: string;
}

const BUCKET_LABELS: Readonly<Record<ChildStatusBucket, string>> = {
  needsInput: "needs input",
  running: "running",
  waiting: "waiting",
  failed: "failed",
  done: "done",
};

/** "1 needs input · 1 running · 6 waiting": the states that have children, most actionable first. */
export function agentChildSummaryText(counts: ChildStatusCounts): string {
  return CHILD_STATUS_BUCKETS.filter((bucket) => counts[bucket] > 0)
    .map((bucket) => `${counts[bucket]} ${BUCKET_LABELS[bucket]}`)
    .join(" · ");
}

/** The summary line's text; needs input is called out in the warning colour. */
export function AgentChildSummaryText({ counts }: { readonly counts: ChildStatusCounts }) {
  const parts = CHILD_STATUS_BUCKETS.filter((bucket) => counts[bucket] > 0);
  return (
    <span className="agent-child-summary-text">
      {parts.map((bucket, index) => (
        <span
          key={bucket}
          data-bucket={bucket}
          style={bucket === "needsInput" ? { color: CHILD_STATUS_COLORS[bucket] } : undefined}
        >
          {index > 0 ? " · " : null}
          {counts[bucket]} {BUCKET_LABELS[bucket]}
        </span>
      ))}
    </span>
  );
}

/**
 * Who is on a collapsed parent's children: each child's agent, ringed in its
 * state colour, linking to that chat. Static rings only; see agents.css.
 */
export function AgentChildAvatarStack({
  avatars,
  overflow,
  profiles,
}: {
  readonly avatars: readonly AgentChildAvatarEntry[];
  readonly overflow: number;
  readonly profiles: readonly McpGatewayProfile[] | undefined;
}) {
  return (
    <span className="agent-child-avatars">
      {avatars.map(({ thread, status, bucket }) => {
        const agent = runAgentName(thread, profiles);
        const label = `${agent.name} · ${thread.title} · ${agentThreadStatusLabel(status)}`;
        return (
          <Tooltip key={`${thread.environmentId}:${thread.id}`}>
            <TooltipTrigger
              render={
                <Link
                  to="/agents/$environmentId/$threadId"
                  params={{ environmentId: thread.environmentId, threadId: thread.id }}
                  className="agent-child-avatar"
                  data-bucket={bucket}
                  aria-label={label}
                  style={
                    {
                      "--agent-color": agent.profile?.color ?? "var(--muted-foreground)",
                      "--agent-state-color": CHILD_STATUS_COLORS[bucket],
                    } as CSSProperties
                  }
                />
              }
            >
              {thread.profileSnapshot === undefined ? (
                <span aria-hidden="true">{agent.name.slice(0, 1).toUpperCase()}</span>
              ) : (
                <AgentIcon icon={agent.profile?.icon} />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
      {overflow > 0 && <span className="agent-child-avatars-more">+{overflow}</span>}
    </span>
  );
}
