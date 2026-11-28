import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type HostPressure,
  type HostPressureAgent,
  type HostPressureKind,
  hostPressureRanking,
  severeHostPressureKinds,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { memo } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useForceStopThread } from "../chat/useForceStopThread";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

type GT = ReturnType<typeof useGT>;
type Strained = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly pressure: HostPressure;
};

/** Only severe pressure earns a warning: a machine that is merely busy is working as intended. */
export const SidebarHostPressureWarning = memo(function SidebarHostPressureWarning() {
  const gt = useGT();
  const configs = useServerConfigs();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const strained = [...configs].flatMap(([environmentId, config]): ReadonlyArray<Strained> => {
    const pressure = config.hostPressure;
    // A disconnected machine's last sample is stale, not a current warning.
    const connected = presentations.get(environmentId)?.connection.phase === "connected";
    return connected && pressure !== undefined && severeHostPressureKinds(pressure).length > 0
      ? [{ environmentId, label: config.environment.label, pressure }]
      : [];
  });
  const only = strained.length === 1 ? strained[0]! : null;
  if (strained.length === 0) return null;
  // One notice however many machines are strained, so the sidebar never fills with warnings.
  const pillTitle =
    only === null
      ? machinesTitle(gt, strained)
      : kindTitle(
          gt,
          severeHostPressureKinds(only.pressure)[0]!,
          configs.size > 1 ? only.label : null,
        );
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="warning-outline"
            size="compact"
            data-host-pressure={strained.map((entry) => entry.environmentId).join(" ")}
            className="w-full shrink-0 justify-start"
          />
        }
      >
        <TriangleAlertIcon />
        <span className="min-w-0 truncate">{pillTitle}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" padding="compact">
        {only === null ? (
          <MachinesDetails strained={strained} />
        ) : (
          <>
            <KindExplanations
              kinds={severeHostPressureKinds(only.pressure)}
              pressure={only.pressure}
              machineName={configs.size > 1 ? only.label : null}
            />
            <AgentList environmentId={only.environmentId} pressure={only.pressure} />
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
});

/** Overload covers both CPU and storage stalls, which share one title. */
const titleGroup = (kind: HostPressureKind) => (kind === "io" ? "cpu" : kind);

function machinesTitle(gt: GT, strained: ReadonlyArray<Strained>): string {
  const count = strained.length;
  const groups = new Set(
    strained.map((entry) => titleGroup(severeHostPressureKinds(entry.pressure)[0]!)),
  );
  if (groups.size > 1) return gt("{count} machines need attention", { count });
  switch ([...groups][0]!) {
    case "memory":
      return gt("Memory is slowing agents on {count} machines", { count });
    case "disk":
      return gt("{count} machines are almost out of disk space", { count });
    default:
      return gt("{count} machines are overloaded", { count });
  }
}

function kindTitle(gt: GT, kind: HostPressureKind, name: string | null): string {
  switch (kind) {
    case "memory":
      return name === null
        ? gt("Memory is slowing agents down")
        : gt("Memory is slowing agents on {name}", { name });
    case "disk":
      return name === null
        ? gt("Almost out of disk space")
        : gt("{name} is almost out of disk space", { name });
    case "cpu":
    case "io":
      return name === null ? gt("Machine overloaded") : gt("{name} is overloaded", { name });
  }
}

/** Without a single machine's reading, the disk explanation leaves out the free space. */
function kindExplanation(gt: GT, kind: HostPressureKind, pressure: HostPressure | null): string {
  switch (kind) {
    case "memory":
      return gt(
        "Agents keep waiting while the system frees up memory, so they may stop responding. Stopping the largest agent helps the rest.",
      );
    case "disk":
      return pressure === null || pressure.diskFreeBytes === null
        ? gt("Agents fail once the disk is full. Remove worktrees you no longer need.")
        : gt(
            "{free} left where T3 Code keeps its data and worktrees. Agents fail once it is full. Remove worktrees you no longer need.",
            { free: formatBytes(pressure.diskFreeBytes) },
          );
    case "cpu":
      return gt("Work waits for a free CPU most of the time, so agents and builds run slowly.");
    case "io":
      return gt("Work waits on disk reads and writes most of the time, so agents run slowly.");
  }
}

function KindExplanations(props: {
  readonly kinds: ReadonlyArray<HostPressureKind>;
  readonly pressure: HostPressure | null;
  readonly machineName: string | null;
}) {
  const gt = useGT();
  return props.kinds.map((kind, index) => (
    <div key={kind} className={index === 0 ? undefined : "mt-3"}>
      <PopoverTitle>{kindTitle(gt, kind, props.machineName)}</PopoverTitle>
      <p className="mt-1 max-w-64 text-caption text-muted-foreground">
        {kindExplanation(gt, kind, props.pressure)}
      </p>
    </div>
  ));
}

/** Each problem is explained once; each machine then lists its own problems and agents. */
function MachinesDetails(props: { readonly strained: ReadonlyArray<Strained> }) {
  const gt = useGT();
  const kinds = (["memory", "disk", "cpu", "io"] as const).filter((kind) =>
    props.strained.some((entry) => entry.pressure[kind] === "severe"),
  );
  return (
    <>
      <KindExplanations kinds={kinds} pressure={null} machineName={null} />
      {props.strained.map((entry) => (
        <section key={entry.environmentId} className="mt-3 border-t border-border/60 pt-2">
          <p className="truncate text-caption">{entry.label}</p>
          {kinds.length > 1 ? (
            <ul className="mt-0.5 text-caption text-muted-foreground">
              {severeHostPressureKinds(entry.pressure).map((kind) => (
                <li key={kind}>{kindTitle(gt, kind, null)}</li>
              ))}
            </ul>
          ) : null}
          <AgentList environmentId={entry.environmentId} pressure={entry.pressure} />
        </section>
      ))}
    </>
  );
}

function AgentList(props: {
  readonly environmentId: EnvironmentId;
  readonly pressure: HostPressure;
}) {
  const rankedBy = hostPressureRanking(props.pressure);
  if (props.pressure.heaviestAgents.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {props.pressure.heaviestAgents.map((agent, index) => (
        <HostPressureAgentRow
          key={agent.threadId ?? `${agent.agent}:${index}`}
          environmentId={props.environmentId}
          agent={agent}
          rankedBy={rankedBy}
        />
      ))}
    </ul>
  );
}

/** Memory or cores, whichever the server ranked agents by. */
export function hostPressureAgentUsage(
  gt: GT,
  agent: HostPressureAgent,
  rankedBy: "memory" | "cpu",
): string {
  return rankedBy === "memory" || agent.cpuCores === null
    ? formatBytes(agent.memoryBytes)
    : gt("{count, plural, one {{count} core} other {{count} cores}}", { count: agent.cpuCores });
}

function HostPressureAgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: HostPressureAgent;
  readonly rankedBy: "memory" | "cpu";
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const threadId = props.agent.threadId;
  const threadRef = threadId === null ? null : scopeThreadRef(props.environmentId, threadId);
  const thread = useThreadShell(threadRef);
  const forceStop = useForceStopThread(props.environmentId);
  const name =
    thread?.title ??
    (threadId === null ? gt("{agent} (shared)", { agent: props.agent.agent }) : props.agent.agent);
  return (
    <li className="flex min-w-0 items-center gap-2 text-caption">
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
        {hostPressureAgentUsage(gt, props.agent, props.rankedBy)}
      </span>
      {threadId !== null && forceStop.canForceStop ? (
        <InlineButton
          tone="muted"
          disabled={forceStop.stoppingThreadId === threadId}
          onClick={() => void forceStop.forceStopThread(threadId)}
        >
          {forceStop.stoppingThreadId === threadId ? <T>Force stopping...</T> : <T>Force stop</T>}
        </InlineButton>
      ) : null}
    </li>
  );
}
