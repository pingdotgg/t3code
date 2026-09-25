import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { isSubagentThreadId } from "./subagentThreads";

/**
 * Agents panel rows for child threads (toolboxmd/t3code#8) open that
 * thread, where the user reads it and messages it with the normal composer.
 * Rows for native provider subagents stay plain.
 */
export function AgentThreadLink(props: {
  agentId: string;
  environmentId: EnvironmentId | null;
  children: ReactNode;
}) {
  if (props.environmentId === null || !isSubagentThreadId(props.agentId)) {
    return props.children;
  }
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId: props.agentId as ThreadId }}
      className="block rounded-md hover:bg-accent/50"
      data-testid="agents-panel-thread-link"
    >
      {props.children}
    </Link>
  );
}
