import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useLayoutEffect, useMemo, useRef } from "react";

import { timelineSource } from "../chat/projectionSource";
import { timelineRows } from "../chat/timeline";
import { TimelineRowView } from "../chat/TimelineRowView";
import type { AgentView } from "../state/boardModel";
import { useEnvironmentThread } from "../state/threads";

/** The read-only log of one agent's thread. It has no box to send into, because only the orchestrator takes the user's messages. */
export function AgentLog({
  environmentId,
  agent,
}: {
  environmentId: EnvironmentId;
  agent: AgentView;
}) {
  const state = useEnvironmentThread(environmentId, ThreadId.make(agent.threadId));
  const projection = Option.getOrNull(state.data);
  const rows = useMemo(
    () => (projection === null ? [] : timelineRows(timelineSource(projection))),
    [projection],
  );
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && atBottom.current) element.scrollTop = element.scrollHeight;
  });
  const failure = Option.getOrNull(state.error);
  return (
    <div
      ref={scroller}
      data-testid="peek-log"
      role="log"
      aria-label={`${agent.role} thread log`}
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
    >
      {projection === null && failure !== null && (
        <p role="alert" className="text-red-400">
          {failure}
        </p>
      )}
      {projection === null && failure === null && <p className="text-faint">Reading the thread</p>}
      {projection !== null && rows.length === 0 && <p className="text-faint">Nothing yet</p>}
      {rows.map((row) => (
        <TimelineRowView key={row.id} row={row} brief={false} />
      ))}
    </div>
  );
}
