import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type HostPressureLevel,
  worstHostPressureLevel,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CpuIcon, HardDriveIcon, MemoryStickIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { Meter } from "../ui/meter";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

type LoadTone = "destructive" | "warning" | null;

const toneOf = (level: HostPressureLevel | undefined): LoadTone =>
  level === "severe" ? "destructive" : level === "elevated" ? "warning" : null;

const percent = (fraction: number) => Math.round(Math.max(0, Math.min(1, fraction)) * 100);

/** CPU, memory and disk on the machine the thread runs on, colored by whether work there stalls. */
export function ThreadDetailsMachineLoad({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const result = useAtomValue(serverEnvironment.liveHostResources({ environmentId, input: {} }));
  const pressure = useServerConfigs().get(environmentId)?.hostPressure;
  const connected = useAtomValue(
    environmentPresentations.presentationsAtom,
    (presentations) => presentations.get(environmentId)?.connection.phase === "connected",
  );
  // A reconnecting query keeps its last sample, also briefly after it reconnects. Live gauges
  // stay hidden until a sample newer than the one held when the connection dropped arrives.
  const sample = result._tag === "Success" ? result.value : null;
  const [staleSample, setStaleSample] = useState<typeof sample>(null);
  if (!connected && sample !== null && sample !== staleSample) setStaleSample(sample);
  if (!connected || sample === null || sample === staleSample) return null;
  const snapshot = sample;
  const usedMemory = snapshot.totalMemoryBytes - snapshot.availableMemoryBytes;
  const diskFree = snapshot.diskFreeBytes ?? null;
  const diskTotal = snapshot.diskTotalBytes ?? null;
  // CPU and storage stalls both slow work down, so the CPU row carries the worse of the two.
  const cpuTone =
    pressure === undefined
      ? null
      : toneOf(worstHostPressureLevel({ ...pressure, memory: "none", disk: "none" }));
  return (
    <ThreadDetailsSection title={gt("Machine load")} variant="usage">
      <LoadRow
        label={gt("CPU", { $context: "machine load row label" })}
        icon={<CpuIcon className="size-4 shrink-0" aria-hidden />}
        fill={snapshot.cpuUtilization === null ? null : percent(snapshot.cpuUtilization)}
        tone={cpuTone}
        value={
          snapshot.cpuUtilization === null
            ? gt("Unavailable")
            : `${percent(snapshot.cpuUtilization)}%`
        }
        tooltip={
          cpuTone === null
            ? gt("{count, plural, one {{count} CPU} other {{count} CPUs}}", {
                count: snapshot.cpuCount,
              })
            : gt("Work waits for a free CPU or for the disk, so agents run slowly.")
        }
      />
      <LoadRow
        label={gt("Memory", { $context: "machine load row label" })}
        icon={<MemoryStickIcon className="size-4 shrink-0" aria-hidden />}
        fill={
          snapshot.totalMemoryBytes > 0 ? percent(usedMemory / snapshot.totalMemoryBytes) : null
        }
        tone={toneOf(pressure?.memory)}
        value={`${formatBytes(usedMemory)} / ${formatBytes(snapshot.totalMemoryBytes)}`}
        tooltip={
          pressure?.memory === undefined || pressure.memory === "none"
            ? gt("{available} available", {
                available: formatBytes(snapshot.availableMemoryBytes),
              })
            : gt("Agents keep waiting while the system frees up memory.")
        }
      />
      {diskFree !== null && diskTotal !== null && diskTotal > 0 ? (
        <LoadRow
          label={gt("Disk", { $context: "machine load row label" })}
          icon={<HardDriveIcon className="size-4 shrink-0" aria-hidden />}
          fill={percent((diskTotal - diskFree) / diskTotal)}
          tone={toneOf(pressure?.disk)}
          value={gt("{free} free", { free: formatBytes(diskFree) })}
          tooltip={gt("Where T3 Code keeps its data and worktrees")}
        />
      ) : null}
    </ThreadDetailsSection>
  );
}

/** The Context row's anatomy: icon, label, meter, value; the tooltip explains the tint. */
function LoadRow(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly fill: number | null;
  readonly tone: LoadTone;
  readonly value: string;
  readonly tooltip: string;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            part="row"
            className="cursor-default"
            render={
              <span
                tabIndex={0}
                aria-label={gt("{label}: {value}", { label: props.label, value: props.value })}
              />
            }
          />
        }
      >
        {props.icon}
        <span className="min-w-0 truncate">{props.label}</span>
        <span className="flex flex-1 items-center gap-1.5">
          {props.fill !== null ? (
            <span className="min-w-12 flex-1">
              <Meter value={props.fill} max={100} tone={props.tone ?? "neutral"} aria-hidden />
            </span>
          ) : null}
          <span
            className={cn(
              "shrink-0 text-end tabular-nums text-muted-foreground",
              props.fill === null && "ms-auto",
              props.tone === "destructive" && "text-error-foreground",
              props.tone === "warning" && "text-warning-foreground",
            )}
          >
            {props.value}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left" sideOffset={12}>
        <span className="text-foreground">{props.tooltip}</span>
      </TooltipPopup>
    </Tooltip>
  );
}
