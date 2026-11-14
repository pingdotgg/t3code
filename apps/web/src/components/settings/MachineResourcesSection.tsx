import {
  machineCpuDetail,
  machineGpuMemory,
  machineGpuState,
  machineMemoryUsedShare,
  machineStorageState,
  machineVolumeLabel,
  machineVolumeTone,
  machineVolumeUsedShare,
  type MachineVolumeTone,
} from "@t3tools/client-runtime/machine-resources";
import type { EnvironmentId, HostGpu, HostResourcesSnapshot, HostVolume } from "@t3tools/contracts";
import type { ReactNode } from "react";
import {
  AlertTriangleIcon,
  CpuIcon,
  GpuIcon,
  HardDriveIcon,
  MemoryStickIcon,
  MonitorIcon,
} from "lucide-react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./settingsLayout";

const ROLE_LABELS: Record<HostVolume["roles"][number], string> = {
  t3Home: "T3 data",
  worktrees: "Worktrees",
};

function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function UsageBar({ share, tone = "default" }: { share: number; tone?: MachineVolumeTone }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className={cn(
          "h-full rounded-full bg-foreground/55",
          tone === "warning" && "bg-warning",
          tone === "danger" && "bg-destructive",
        )}
        style={{ width: `${Math.round(share * 1000) / 10}%` }}
      />
    </div>
  );
}

function MachineStat({
  icon,
  label,
  value,
  detail,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
        <span className="text-muted-foreground/55">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2.5 truncate font-mono text-2xl font-semibold tracking-tighter tabular-nums text-foreground">
        {value}
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
      {detail ? (
        <div className="mt-1.5 truncate text-3xs text-muted-foreground/60">{detail}</div>
      ) : null}
    </div>
  );
}

function CoreStrip({ cores }: { cores: HostResourcesSnapshot["cpuCoreUtilization"] }) {
  if (cores === undefined) {
    return (
      <div className="mt-1.5 text-3xs text-muted-foreground/60">
        Per-core load not reported by this server
      </div>
    );
  }
  return (
    <div
      className="mt-2 flex h-5 items-end gap-px"
      role="img"
      aria-label={`Per-core load: ${cores.map(formatPercent).join(", ")}`}
    >
      {cores.map((share, index) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- a core's only identity is its position
          key={index}
          className="flex h-full min-w-px flex-1 items-end overflow-hidden rounded-xs bg-muted"
        >
          <div
            className="w-full bg-foreground/55"
            style={{ height: `${Math.round(share * 100)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function GpuRow({ gpu }: { gpu: HostGpu }) {
  const memory = machineGpuMemory(gpu);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="truncate text-xs font-medium text-foreground">{gpu.name}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-foreground">
          {gpu.utilization === undefined
            ? "Load unavailable"
            : `${formatPercent(gpu.utilization)} busy`}
        </span>
      </div>
      {gpu.utilization === undefined ? null : <UsageBar share={gpu.utilization} />}
      {memory.kind === "unreported" ? null : (
        <div className="flex justify-between text-3xs text-muted-foreground/60">
          {memory.kind === "dedicated" ? (
            <>
              <span>
                {memory.usedBytes === undefined
                  ? "VRAM in use not reported"
                  : `${formatBytes(memory.usedBytes)} VRAM used`}
              </span>
              <span>{formatBytes(memory.totalBytes)} total</span>
            </>
          ) : (
            <>
              <span>{formatBytes(memory.usedBytes)} in use</span>
              <span>Unified memory</span>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function GpuSection({ snapshot }: { snapshot: HostResourcesSnapshot }) {
  const state = machineGpuState(snapshot);
  return (
    <div className="border-t border-border/60">
      <div className="flex items-center gap-2 px-4 pt-3 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70 sm:px-5">
        <GpuIcon className="size-3.5 text-muted-foreground/55" />
        GPU
      </div>
      {state.kind === "unsupported" ? (
        <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
          GPUs are not reported by this server. Update it to see them.
        </p>
      ) : state.kind === "empty" ? (
        <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
          {state.notice ?? "No GPU found."}
        </p>
      ) : (
        <>
          {state.notice ? (
            <p className="flex items-start gap-1.5 px-4 pt-2 text-3xs text-muted-foreground sm:px-5">
              <AlertTriangleIcon className="mt-px size-3 shrink-0 text-warning" />
              {state.notice}
            </p>
          ) : null}
          <ul className="divide-y divide-border/45">
            {state.gpus.map((gpu, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- identical GPUs share a name
              <GpuRow key={`${index}:${gpu.name}`} gpu={gpu} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function VolumeRow({ volume }: { volume: HostVolume }) {
  const tone = machineVolumeTone(volume);
  const usedBytes = Math.max(0, volume.totalBytes - volume.availableBytes);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-xs font-medium text-foreground">
            {machineVolumeLabel(volume)}
          </span>
          <span className="truncate font-mono text-3xs text-muted-foreground/60">
            {volume.mountPoint}
            {volume.fileSystem ? ` · ${volume.fileSystem}` : ""}
          </span>
          {volume.roles.map((role) => (
            <span
              key={role}
              className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-3xs text-muted-foreground"
            >
              {ROLE_LABELS[role]}
            </span>
          ))}
        </div>
        <span
          className={cn(
            "shrink-0 font-mono text-xs tabular-nums text-foreground",
            tone === "warning" && "text-warning-foreground",
            tone === "danger" && "text-destructive",
          )}
        >
          {formatBytes(volume.availableBytes)} free
        </span>
      </div>
      <UsageBar share={machineVolumeUsedShare(volume)} tone={tone} />
      <div className="flex justify-between text-3xs text-muted-foreground/60">
        <span>{formatBytes(usedBytes)} used</span>
        <span>{formatBytes(volume.totalBytes)} total</span>
      </div>
    </li>
  );
}

function MachineResourcesView({
  snapshot,
  error,
}: {
  snapshot: HostResourcesSnapshot | null;
  error: string | null;
}) {
  if (!snapshot) {
    return (
      <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
        {error ?? "Reading machine resources…"}
      </div>
    );
  }
  const memoryShare = machineMemoryUsedShare(snapshot);
  const storageState = machineStorageState(snapshot);
  return (
    <div className="overflow-hidden rounded-[inherit]">
      <div className="grid grid-cols-1 divide-y divide-border/55 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <MachineStat
          icon={<CpuIcon className="size-3.5" />}
          label="CPU"
          value={
            snapshot.cpuUtilization === null
              ? "Unavailable"
              : formatPercent(snapshot.cpuUtilization)
          }
          detail={machineCpuDetail(snapshot)}
        >
          {snapshot.cpuUtilization === null ? null : <UsageBar share={snapshot.cpuUtilization} />}
          <CoreStrip cores={snapshot.cpuCoreUtilization} />
        </MachineStat>
        <MachineStat
          icon={<MemoryStickIcon className="size-3.5" />}
          label="Memory"
          value={`${formatBytes(snapshot.totalMemoryBytes - snapshot.availableMemoryBytes)} / ${formatBytes(snapshot.totalMemoryBytes)}`}
          detail={[
            `${formatBytes(snapshot.availableMemoryBytes)} available`,
            snapshot.swap && snapshot.swap.totalBytes > 0
              ? `swap ${formatBytes(snapshot.swap.usedBytes)} / ${formatBytes(snapshot.swap.totalBytes)}`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <UsageBar share={memoryShare} />
        </MachineStat>
      </div>
      <GpuSection snapshot={snapshot} />
      <div className="border-t border-border/60">
        <div className="flex items-center gap-2 px-4 pt-3 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70 sm:px-5">
          <HardDriveIcon className="size-3.5 text-muted-foreground/55" />
          Disks
        </div>
        {storageState.kind === "unsupported" ? (
          <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
            This server is too old to report disk usage. Update it to see its volumes.
          </p>
        ) : (
          <>
            {storageState.notice ? (
              <p className="flex items-start gap-1.5 px-4 pt-2 text-3xs text-muted-foreground sm:px-5">
                <AlertTriangleIcon className="mt-px size-3 shrink-0 text-warning" />
                {storageState.notice}
              </p>
            ) : null}
            {storageState.kind === "empty" ? (
              <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
                No volumes reported.
              </p>
            ) : (
              <ul className="divide-y divide-border/45">
                {storageState.volumes.map((volume) => (
                  <VolumeRow key={volume.mountPoint} volume={volume} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Whole-machine CPU, memory, GPU and disks of the selected environment's host. Polls while mounted. */
export function MachineResourcesSection({ environmentId }: { environmentId: EnvironmentId }) {
  const { data, error } = useEnvironmentQuery(
    serverEnvironment.machineResources({ environmentId, input: {} }),
  );
  return (
    <SettingsSection
      title="Machine"
      icon={<MonitorIcon className="size-4 text-muted-foreground" />}
    >
      <MachineResourcesView snapshot={data} error={data ? null : error} />
    </SettingsSection>
  );
}
