import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ThreadId,
  hostPressureCulprit,
  hostPressureRanking,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";

import { environmentPresentations } from "../../state/presentation";
import { hostPressureAgentUsage } from "./SidebarHostPressureWarning";

/** Selects primitives and the server's own agent object, so only culprit rows re-render. */
function useThreadHostPressureNote(environmentId: EnvironmentId, threadId: ThreadId) {
  const gt = useGT();
  const agent = useAtomValue(environmentPresentations.serverConfigsAtom, (configs) =>
    hostPressureCulprit(configs.get(environmentId)?.hostPressure, threadId),
  );
  const rankedBy = useAtomValue(environmentPresentations.serverConfigsAtom, (configs) => {
    const pressure = configs.get(environmentId)?.hostPressure;
    return pressure === undefined ? "memory" : hostPressureRanking(pressure);
  });
  const connected = useAtomValue(
    environmentPresentations.presentationsAtom,
    (presentations) => presentations.get(environmentId)?.connection.phase === "connected",
  );
  if (agent === null || !connected) return null;
  const usage = hostPressureAgentUsage(gt, agent, rankedBy);
  return rankedBy === "memory"
    ? gt("Using {usage} while memory is slowing agents down. Stopping it helps the rest.", {
        usage,
      })
    : gt("Using {usage} while this machine is overloaded. Stopping it helps the rest.", {
        usage,
      });
}

/** Marks a thread whose agent is among the heaviest on a machine short on memory or CPU. */
export function SidebarThreadHostPressureIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const note = useThreadHostPressureNote(props.environmentId, props.threadId);
  if (note === null) return null;
  return (
    <TriangleAlertIcon
      role="img"
      aria-label={note}
      data-testid={`sidebar-host-pressure-${props.threadId}`}
      className="size-3 shrink-0 text-warning-foreground"
    />
  );
}

export function SidebarThreadHostPressureLine(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const note = useThreadHostPressureNote(props.environmentId, props.threadId);
  if (note === null) return null;
  return (
    <div className="flex min-w-0 items-start gap-2 text-warning">
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
      <div className="min-w-0 flex-1 wrap-break-word">{note}</div>
    </div>
  );
}
