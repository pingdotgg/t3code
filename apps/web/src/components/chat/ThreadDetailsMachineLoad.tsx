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
      {/* One grid, so the meters share a column and every value ends on the same edge. */}
      <div className="grid grid-cols-[calc(1rem+--spacing(2.5))_max-content_minmax(3rem,1fr)_minmax(0,max-content)] gap-x-2.5">
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
          value={memoryForms(usedMemory, snapshot.totalMemoryBytes)}
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
            value={[
              gt("{free} free", { free: formatBytes(diskFree) }),
              `${percent((diskTotal - diskFree) / diskTotal)}%`,
            ]}
            tooltip={gt("Where T3 Code keeps its data and worktrees")}
          />
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

/** "16.8 GB / 62.8 GB", then "16.8 / 62.8 GB" when both share a unit, then the percent used. */
function memoryForms(used: number, total: number): readonly string[] {
  const usedText = formatBytes(used);
  const totalText = formatBytes(total);
  const full = `${usedText} / ${totalText}`;
  if (total <= 0) return [full];
  const usedUnit = usedText.slice(usedText.lastIndexOf(" "));
  const shared = totalText.endsWith(usedUnit)
    ? [`${usedText.slice(0, -usedUnit.length)} / ${totalText}`]
    : [];
  return [full, ...shared, `${percent(used / total)}%`];
}

/**
 * Shows the first form that fits, without measuring: each shorter form sits in a box that adds
 * no width, so it shares the line only while the longer form fits beside it and shows once that
 * form wraps onto the clipped second line.
 */
function FittedValue({ forms }: { readonly forms: readonly string[] }): ReactNode {
  const [form, ...shorter] = forms;
  if (shorter.length === 0) return <span className="min-w-0 truncate">{form}</span>;
  return (
    <span className="flex h-lh min-w-0 flex-wrap justify-end overflow-hidden">
      <span className="-ms-[100%] flex w-full justify-end [contain:inline-size]">
        <FittedValue forms={shorter} />
      </span>
      <span className="whitespace-nowrap">{form}</span>
    </span>
  );
}

/** The Context row's anatomy: icon, label, meter, value; the tooltip explains the tint. */
function LoadRow(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly fill: number | null;
  readonly tone: LoadTone;
  /** Longest first; the row shows the first that fits. */
  readonly value: string | readonly string[];
  readonly tooltip: string;
}) {
  const gt = useGT();
  const forms = typeof props.value === "string" ? [props.value] : props.value;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            part="row"
            className="col-span-full grid cursor-default grid-cols-subgrid"
            render={
              <span
                tabIndex={0}
                aria-label={gt("{label}: {value}", { label: props.label, value: forms[0] })}
              />
            }
          />
        }
      >
        {props.icon}
        <span className="min-w-0 truncate">{props.label}</span>
        {props.fill !== null ? (
          <Meter value={props.fill} max={100} tone={props.tone ?? "neutral"} aria-hidden />
        ) : null}
        <span
          aria-hidden
          className={cn(
            // The Context row keeps 6px between meter and value; a text-only row spans the meter column.
            "-ms-1 flex min-w-0 justify-end tabular-nums text-muted-foreground",
            props.fill === null && "col-span-2 ms-0",
            props.tone === "destructive" && "text-error-foreground",
            props.tone === "warning" && "text-warning-foreground",
          )}
        >
          <FittedValue forms={forms} />
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left" sideOffset={12}>
        <span className="text-foreground">{props.tooltip}</span>
      </TooltipPopup>
    </Tooltip>
  );
}
