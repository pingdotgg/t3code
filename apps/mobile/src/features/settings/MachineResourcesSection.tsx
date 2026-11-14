import {
  machineCpuDetail,
  machineGpuState,
  machineMemoryUsedShare,
  machineStorageState,
  machineVolumeLabel,
  machineVolumeTone,
  machineVolumeUsedShare,
  type MachineVolumeTone,
} from "@t3tools/client-runtime/machine-resources";
import type { EnvironmentId, HostResourcesSnapshot, HostVolume } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/formatBytes";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./components/SettingsSection";
import {
  formatShare,
  machineCoresSummary,
  machineGpuDetail,
  machineMemoryDetail,
} from "./MachineResourcesSection.logic";

const ROLE_LABELS: Record<HostVolume["roles"][number], string> = {
  t3Home: "T3 data",
  worktrees: "Worktrees",
};

// The native Progress control only tints with the primary colour, so tones need a plain bar.
function UsageBar(props: {
  readonly share: number;
  readonly label: string;
  readonly tone?: MachineVolumeTone;
}) {
  const share = Math.min(1, Math.max(0, props.share));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={props.label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}
      className="h-1.5 w-full overflow-hidden rounded-full bg-subtle"
    >
      <View
        className={cn(
          "h-full rounded-full",
          props.tone === "danger"
            ? "bg-danger-foreground"
            : props.tone === "warning"
              ? "bg-warning-foreground"
              : "bg-foreground-muted",
        )}
        style={{ width: `${Math.round(share * 1000) / 10}%` }}
      />
    </View>
  );
}

function Stat(props: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | null;
  readonly children?: ReactNode;
}) {
  return (
    <View className="gap-1.5 p-4">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text textRole="body" className="font-t3-medium text-foreground">
          {props.label}
        </Text>
        <Text textRole="body" className="shrink tabular-nums text-foreground" numberOfLines={1}>
          {props.value}
        </Text>
      </View>
      {props.children}
      {props.detail ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.detail}
        </Text>
      ) : null}
    </View>
  );
}

function VolumeRow({ volume }: { readonly volume: HostVolume }) {
  const tone = machineVolumeTone(volume);
  const label = machineVolumeLabel(volume);
  const usedBytes = Math.max(0, volume.totalBytes - volume.availableBytes);
  return (
    <View className="gap-1.5 p-4">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text
          textRole="body"
          className="min-w-0 flex-1 font-t3-medium text-foreground"
          numberOfLines={1}
        >
          {label}
        </Text>
        <Text
          textRole="footnote"
          className={cn(
            "tabular-nums",
            tone === "danger"
              ? "font-t3-medium text-danger-foreground"
              : tone === "warning"
                ? "font-t3-medium text-warning-foreground"
                : "text-foreground",
          )}
        >
          {formatBytes(volume.availableBytes)} free
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-1.5">
        <Text textRole="caption" selectable className="shrink text-foreground-muted">
          {volume.mountPoint}
          {volume.fileSystem ? ` · ${volume.fileSystem}` : ""}
        </Text>
        {volume.roles.map((role) => (
          <View key={role} className="rounded bg-subtle px-1.5 py-px">
            <Text textRole="caption" className="text-foreground-muted">
              {ROLE_LABELS[role]}
            </Text>
          </View>
        ))}
      </View>
      <UsageBar share={machineVolumeUsedShare(volume)} tone={tone} label={`${label} disk used`} />
      <View className="flex-row justify-between">
        <Text textRole="caption" className="tabular-nums text-foreground-muted">
          {formatBytes(usedBytes)} used
        </Text>
        <Text textRole="caption" className="tabular-nums text-foreground-muted">
          {formatBytes(volume.totalBytes)} total
        </Text>
      </View>
    </View>
  );
}

function Message(props: { readonly children: string; readonly tone?: "danger" | "warning" }) {
  return (
    <Text
      selectable
      textRole="footnote"
      className={cn(
        "px-4 py-3",
        props.tone === "danger"
          ? "text-danger-foreground"
          : props.tone === "warning"
            ? "text-warning-foreground"
            : "text-foreground-muted",
      )}
    >
      {props.children}
    </Text>
  );
}

function MachineResourcesView({ snapshot }: { readonly snapshot: HostResourcesSnapshot }) {
  const storage = machineStorageState(snapshot);
  const cores = snapshot.cpuCoreUtilization ?? [];
  const gpuState = machineGpuState(snapshot);
  return (
    <>
      <Stat
        label="CPU"
        value={
          snapshot.cpuUtilization === null ? "Unavailable" : formatShare(snapshot.cpuUtilization)
        }
        detail={machineCpuDetail(snapshot)}
      >
        {snapshot.cpuUtilization === null ? null : (
          <UsageBar share={snapshot.cpuUtilization} label="CPU used" />
        )}
        {cores.length > 0 ? (
          <View
            accessible
            accessibilityLabel={`Per-core use: ${machineCoresSummary(cores)}`}
            className="h-4 flex-row items-end gap-px"
          >
            {cores.map((share, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- cores are identified only by position
              <View key={index} className="h-full flex-1 justify-end rounded-sm bg-subtle">
                <View
                  className="rounded-sm bg-foreground-muted"
                  style={{ height: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%` }}
                />
              </View>
            ))}
          </View>
        ) : null}
      </Stat>
      <Stat
        label="Memory"
        value={`${formatBytes(Math.max(0, snapshot.totalMemoryBytes - snapshot.availableMemoryBytes))} / ${formatBytes(snapshot.totalMemoryBytes)}`}
        detail={machineMemoryDetail(snapshot)}
      >
        <UsageBar share={machineMemoryUsedShare(snapshot)} label="Memory used" />
      </Stat>
      {gpuState.kind === "unsupported" ? null : (
        <>
          {gpuState.notice ? <Message tone="warning">{gpuState.notice}</Message> : null}
          {gpuState.kind === "gpus"
            ? gpuState.gpus.map((gpu, index) => (
                <Stat
                  // oxlint-disable-next-line react/no-array-index-key -- identical GPUs share a name; position is the identity
                  key={`${gpu.name}:${index}`}
                  label={gpu.name || "GPU"}
                  value={gpu.utilization === undefined ? "" : formatShare(gpu.utilization)}
                  detail={machineGpuDetail(gpu)}
                >
                  {gpu.utilization === undefined ? null : (
                    <UsageBar share={gpu.utilization} label={`${gpu.name || "GPU"} used`} />
                  )}
                </Stat>
              ))
            : null}
        </>
      )}
      {storage.kind === "unsupported" ? (
        <Message>
          This server is too old to report disk usage. Update it to see its volumes.
        </Message>
      ) : (
        <>
          {storage.notice ? <Message tone="warning">{storage.notice}</Message> : null}
          {storage.kind === "empty" ? (
            <Message>No volumes reported.</Message>
          ) : (
            storage.volumes.map((volume) => <VolumeRow key={volume.mountPoint} volume={volume} />)
          )}
        </>
      )}
    </>
  );
}

/** Whole-machine CPU, memory and disks of the environment's host. Polls only while mounted. */
export function MachineResourcesSection(props: { readonly environmentId: EnvironmentId }) {
  const { data, error } = useEnvironmentQuery(
    serverEnvironment.machineResources({ environmentId: props.environmentId, input: {} }),
  );
  return (
    <SettingsSection title="Machine">
      {data ? (
        <MachineResourcesView snapshot={data} />
      ) : error ? (
        <Message tone="danger">{error}</Message>
      ) : (
        <Message>Reading machine resources…</Message>
      )}
    </SettingsSection>
  );
}
