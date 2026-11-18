import { msg, useGT, useMessages } from "gt-react";
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
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type HostGpu,
  type HostResourcesSnapshot,
  type HostVolume,
} from "@t3tools/contracts";
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
import { useEnvironmentScope } from "../../state/session";
import { SettingsSection } from "./settingsLayout";

const ROLE_LABELS = {
  t3Home: msg("T3 data"),
  worktrees: msg("Worktrees"),
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
  const gt = useGT();
  if (cores === undefined) {
    return (
      <div className="mt-1.5 text-3xs text-muted-foreground/60">
        {gt("Per-core load not reported by this server")}
      </div>
    );
  }
  return (
    <div
      className="mt-2 flex h-5 items-end gap-px"
      role="img"
      aria-label={gt("Per-core load: {cores}", { cores: cores.map(formatPercent).join(", ") })}
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
  const gt = useGT();
  const memory = machineGpuMemory(gpu);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="truncate text-xs font-medium text-foreground">{gpu.name}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-foreground">
          {gpu.utilization === undefined
            ? gt("Load unavailable")
            : gt("{percent} busy", { percent: formatPercent(gpu.utilization) })}
        </span>
      </div>
      {gpu.utilization === undefined ? null : <UsageBar share={gpu.utilization} />}
      {memory.kind === "unreported" ? null : (
        <div className="flex justify-between text-3xs text-muted-foreground/60">
          {memory.kind === "dedicated" ? (
            <>
              <span>
                {memory.usedBytes === undefined
                  ? gt("VRAM in use not reported")
                  : gt("{used} VRAM used", { used: formatBytes(memory.usedBytes) })}
              </span>
              <span>{gt("{bytes} total", { bytes: formatBytes(memory.totalBytes) })}</span>
            </>
          ) : (
            <>
              <span>{gt("{bytes} in use", { bytes: formatBytes(memory.usedBytes) })}</span>
              <span>{gt("Unified memory")}</span>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function GpuSection({ snapshot }: { snapshot: HostResourcesSnapshot }) {
  const gt = useGT();
  const state = machineGpuState(snapshot);
  return (
    <div className="border-t border-border/60">
      <div className="flex items-center gap-2 px-4 pt-3 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70 sm:px-5">
        <GpuIcon className="size-3.5 text-muted-foreground/55" />
        GPU
      </div>
      {state.kind === "unsupported" ? (
        <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
          {gt("GPUs are not reported by this server. Update it to see them.")}
        </p>
      ) : state.kind === "empty" ? (
        <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
          {state.notice ?? gt("No GPU found.")}
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
  const gt = useGT();
  const m = useMessages();
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
              {m(ROLE_LABELS[role])}
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
          {gt("{bytes} free", { bytes: formatBytes(volume.availableBytes) })}
        </span>
      </div>
      <UsageBar share={machineVolumeUsedShare(volume)} tone={tone} />
      <div className="flex justify-between text-3xs text-muted-foreground/60">
        <span>{gt("{bytes} used", { bytes: formatBytes(usedBytes) })}</span>
        <span>{gt("{bytes} total", { bytes: formatBytes(volume.totalBytes) })}</span>
      </div>
    </li>
  );
}

function MachineResourcesView({
  snapshot,
  error,
  dataUpdatedAt,
}: {
  snapshot: HostResourcesSnapshot | null;
  error: string | null;
  dataUpdatedAt: number;
}) {
  const gt = useGT();
  const m = useMessages();
  if (!snapshot) {
    return (
      <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
        {error ?? gt("Reading machine resources…")}
      </div>
    );
  }
  const memoryShare = machineMemoryUsedShare(snapshot);
  const storageState = machineStorageState(snapshot);
  return (
    <div className="overflow-hidden rounded-[inherit]">
      {error ? (
        <p role="status" className="px-4 py-3 text-xs text-warning-foreground sm:px-5">
          {error}{" "}
          <time dateTime={new Date(dataUpdatedAt).toISOString()}>
            {new Date(dataUpdatedAt).toLocaleTimeString()}
          </time>
        </p>
      ) : null}
      <div className="grid grid-cols-1 divide-y divide-border/55 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <MachineStat
          icon={<CpuIcon className="size-3.5" />}
          label="CPU"
          value={
            snapshot.cpuUtilization === null
              ? gt("Unavailable")
              : formatPercent(snapshot.cpuUtilization)
          }
          detail={machineCpuDetail(snapshot, m)}
        >
          {snapshot.cpuUtilization === null ? null : <UsageBar share={snapshot.cpuUtilization} />}
          <CoreStrip cores={snapshot.cpuCoreUtilization} />
        </MachineStat>
        <MachineStat
          icon={<MemoryStickIcon className="size-3.5" />}
          label={gt("Memory")}
          value={`${formatBytes(snapshot.totalMemoryBytes - snapshot.availableMemoryBytes)} / ${formatBytes(snapshot.totalMemoryBytes)}`}
          detail={[
            gt("{bytes} available", { bytes: formatBytes(snapshot.availableMemoryBytes) }),
            snapshot.swap && snapshot.swap.totalBytes > 0
              ? gt("swap {used} / {total}", {
                  used: formatBytes(snapshot.swap.usedBytes),
                  total: formatBytes(snapshot.swap.totalBytes),
                })
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
          {gt("Disks")}
        </div>
        {storageState.kind === "unsupported" ? (
          <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {gt("This server is too old to report disk usage. Update it to see its volumes.")}
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
                {gt("No volumes reported.")}
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
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const { data, error, dataUpdatedAt } = useEnvironmentQuery(
    canRead ? serverEnvironment.machineResources({ environmentId, input: {} }) : null,
  );
  if (!canRead) return null;
  return (
    <SettingsSection
      title={gt("Machine")}
      icon={<MonitorIcon className="size-4 text-muted-foreground" />}
    >
      <MachineResourcesView snapshot={data} error={error} dataUpdatedAt={dataUpdatedAt} />
    </SettingsSection>
  );
}
