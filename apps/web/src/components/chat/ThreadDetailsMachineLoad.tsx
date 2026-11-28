import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type HostPressureLevel,
  worstHostPressureLevel,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CpuIcon, HardDriveIcon, MemoryStickIcon } from "lucide-react";
import { useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { useServerConfigs } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { UsageRow, type UsageTone } from "./ThreadDetailsUsage";

const toneOf = (level: HostPressureLevel | undefined): UsageTone =>
  level === "severe" ? "error" : level === "elevated" ? "warning" : null;

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
        <UsageRow
          label={gt("CPU", { $context: "machine load row label" })}
          icon={<CpuIcon />}
          fill={snapshot.cpuUtilization === null ? null : percent(snapshot.cpuUtilization)}
          tone={cpuTone}
          value={
            snapshot.cpuUtilization === null
              ? gt("Unavailable")
              : `${percent(snapshot.cpuUtilization)}%`
          }
          tooltip={
            <span className="text-foreground">
              {cpuTone === null
                ? gt("{count, plural, one {{count} CPU} other {{count} CPUs}}", {
                    count: snapshot.cpuCount,
                  })
                : gt("Work waits for a free CPU or for the disk, so agents run slowly.")}
            </span>
          }
        />
        <UsageRow
          label={gt("Memory", { $context: "machine load row label" })}
          icon={<MemoryStickIcon />}
          fill={
            snapshot.totalMemoryBytes > 0 ? percent(usedMemory / snapshot.totalMemoryBytes) : null
          }
          tone={toneOf(pressure?.memory)}
          value={`${formatBytes(usedMemory)} / ${formatBytes(snapshot.totalMemoryBytes)}`}
          tooltip={
            <span className="text-foreground">
              {pressure?.memory === undefined || pressure.memory === "none"
                ? gt("{available} available", {
                    available: formatBytes(snapshot.availableMemoryBytes),
                  })
                : gt("Agents keep waiting while the system frees up memory.")}
            </span>
          }
        />
        {diskFree !== null && diskTotal !== null && diskTotal > 0 ? (
          <UsageRow
            label={gt("Disk", { $context: "machine load row label" })}
            icon={<HardDriveIcon />}
            fill={percent((diskTotal - diskFree) / diskTotal)}
            tone={toneOf(pressure?.disk)}
            value={gt("{free} free", { free: formatBytes(diskFree) })}
            tooltip={
              <span className="text-foreground">
                {gt("Where T3 Code keeps its data and worktrees")}
              </span>
            }
          />
        ) : null}
    </ThreadDetailsSection>
  );
}
