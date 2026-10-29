import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  HostMemoryPressure,
  HostMemoryPressureAgent,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { memo } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useForceStopThread } from "../chat/useForceStopThread";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

/** Agents throttled for memory stop answering, so name the heaviest ones while it lasts. */
export const SidebarMemoryPressureWarning = memo(function SidebarMemoryPressureWarning() {
  const configs = useServerConfigs();
  const severe = [...configs].flatMap(([environmentId, config]) =>
    config.memoryPressure?.level === "severe"
      ? [{ environmentId, label: config.environment.label, pressure: config.memoryPressure }]
      : [],
  );
  if (severe.length === 0) return null;
  return (
    <>
      {severe.map((entry) => (
        <MemoryPressurePill
          key={entry.environmentId}
          environmentId={entry.environmentId}
          label={configs.size > 1 ? entry.label : null}
          pressure={entry.pressure}
        />
      ))}
    </>
  );
});

function MemoryPressurePill(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly pressure: HostMemoryPressure;
}) {
  const title = props.label === null ? "Low on memory" : `${props.label} is low on memory`;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="warning-outline"
            size="compact"
            data-memory-pressure={props.environmentId}
            className="w-full shrink-0 justify-start"
          />
        }
      >
        <TriangleAlertIcon />
        <span className="min-w-0 truncate">{title}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" padding="compact">
        <PopoverTitle>{title}</PopoverTitle>
        <p className="mt-1 max-w-64 text-2xs text-muted-foreground">
          The system is slowing agents down to free memory, so they may stop responding. Stopping
          the largest agent helps the rest.
        </p>
        {props.pressure.heaviestAgents.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1">
            {props.pressure.heaviestAgents.map((agent, index) => (
              <MemoryPressureAgentRow
                key={agent.threadId ?? `${agent.agent}:${index}`}
                environmentId={props.environmentId}
                agent={agent}
              />
            ))}
          </ul>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function MemoryPressureAgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: HostMemoryPressureAgent;
}) {
  const navigate = useNavigate();
  const threadId = props.agent.threadId;
  const threadRef = threadId === null ? null : scopeThreadRef(props.environmentId, threadId);
  const thread = useThreadShell(threadRef);
  const forceStop = useForceStopThread(props.environmentId);
  const name =
    thread?.title ?? (threadId === null ? `${props.agent.agent} (shared)` : props.agent.agent);
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs">
      {threadRef === null ? (
        <span className="min-w-0 flex-1 truncate">{name}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          <InlineButton
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(threadRef),
              })
            }
          >
            {name}
          </InlineButton>
        </span>
      )}
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatBytes(props.agent.memoryBytes)}
      </span>
      {threadId !== null && forceStop.canForceStop ? (
        <InlineButton
          tone="muted"
          disabled={forceStop.stoppingThreadId === threadId}
          onClick={() => void forceStop.forceStopThread(threadId)}
        >
          {forceStop.stoppingThreadId === threadId ? "Force stopping..." : "Force stop"}
        </InlineButton>
      ) : null}
    </li>
  );
}
