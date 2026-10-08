import { useAtomValue } from "@effect/atom-react";
import {
  type FleetMachine,
  type FleetWarning,
  fleetTotals,
  formatBytes,
  formatSince,
  formatUsedOfTotal,
} from "@cz/client-runtime/fleet";
import type { EnvironmentId } from "@cz/contracts";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { AppState, Pressable, ScrollView, View } from "react-native";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { MaterialButton } from "../../components/MaterialButton";
import { appAtomRegistry } from "../../state/atom-registry";
import { fleetAtom } from "../../state/fleet";
import { useWakeEnvironment } from "../../state/hostWake";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** How often host readings refresh while the screen is open and the app is active. */
const REFRESH_MS = 3000;

const levelClass = (ratio: number) =>
  ratio >= 0.9 ? "bg-danger-foreground" : ratio >= 0.7 ? "bg-warning-foreground" : "bg-primary";

function Meter({ ratio, muted }: { readonly ratio: number; readonly muted: boolean }) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return (
    <View className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
      <View
        className={`h-full rounded-full ${muted ? "bg-icon-muted" : levelClass(clamped)}`}
        style={{ width: `${Math.max(clamped > 0 ? 2 : 0, clamped * 100)}%` }}
      />
    </View>
  );
}

function Gauge(props: {
  readonly label: string;
  readonly ratio: number;
  readonly value: string;
  readonly muted: boolean;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <Text className="w-16 text-xs text-foreground-muted" numberOfLines={1}>
        {props.label}
      </Text>
      <Meter ratio={props.ratio} muted={props.muted} />
      <Text className="text-xs text-foreground">{props.value}</Text>
    </View>
  );
}

const warningText = (warning: FleetWarning) =>
  warning.kind === "disk"
    ? `${warning.mount} has ${formatBytes(warning.freeBytes)} free`
    : warning.kind === "memory"
      ? `Memory ${Math.round(warning.usedRatio * 100)}% used`
      : `Swap ${Math.round(warning.usedRatio * 100)}% used`;

const STATE_LABEL: Record<FleetMachine["state"], string> = {
  awake: "Awake",
  connecting: "Connecting",
  busy: "Busy, not responding",
  asleep: "Asleep",
  unreachable: "Unreachable",
};

function MachineCard({ machine, now }: { readonly machine: FleetMachine; readonly now: number }) {
  const navigation = useNavigation();
  const wake = useWakeEnvironment();
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, "stop agent");
  const [wakeNote, setWakeNote] = useState<string | null>(null);
  const { resources } = machine;
  const awake = machine.state === "awake";
  const memUsed = resources ? resources.totalMemoryBytes - resources.availableMemoryBytes : 0;
  const zramRam = (resources?.swap?.devices ?? [])
    .filter((device) => device.kind === "zram")
    .reduce((sum, device) => sum + (device.memoryBytes ?? 0), 0);

  return (
    <View
      className={`gap-3 rounded-2xl border-continuous bg-grouped-card p-4 ${machine.warnings.length > 0 ? "border border-danger-border" : ""}`}
    >
      <View className="flex-row items-center gap-2">
        <View
          className={`size-2 rounded-full ${awake ? "bg-primary" : machine.state === "asleep" ? "bg-icon-muted" : machine.state === "connecting" || machine.state === "busy" ? "bg-warning-foreground" : "bg-danger-foreground"}`}
        />
        <Text className="flex-shrink text-base font-cz-medium text-foreground" numberOfLines={1}>
          {machine.label}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {STATE_LABEL[machine.state]}
          {awake && resources?.loadAverage?.[0] !== undefined
            ? ` · load ${resources.loadAverage[0].toFixed(1)} · ${resources.cpuCount} cores`
            : ""}
        </Text>
      </View>

      {machine.warnings.length > 0 ? (
        <Text className="text-xs text-danger-foreground">
          ⚠ {machine.warnings.map(warningText).join(" · ")}
        </Text>
      ) : null}

      {resources && machine.state !== "unreachable" ? (
        <View className="gap-1.5">
          <Gauge
            label="CPU"
            ratio={resources.cpuUtilization ?? 0}
            value={`${Math.round((resources.cpuUtilization ?? 0) * 100)}%`}
            muted={!awake}
          />
          <Gauge
            label="Memory"
            ratio={resources.totalMemoryBytes > 0 ? memUsed / resources.totalMemoryBytes : 0}
            value={formatUsedOfTotal(memUsed, resources.totalMemoryBytes)}
            muted={!awake}
          />
          {resources.swap && resources.swap.totalBytes > 0 ? (
            <Gauge
              label="Swap"
              ratio={resources.swap.usedBytes / resources.swap.totalBytes}
              value={`${formatUsedOfTotal(resources.swap.usedBytes, resources.swap.totalBytes)}${zramRam > 0 ? ` · zram ${formatBytes(zramRam)}` : ""}`}
              muted={!awake}
            />
          ) : null}
          {(resources.disks ?? []).map((disk) => (
            <Gauge
              key={disk.mount}
              label={disk.mount}
              ratio={disk.totalBytes > 0 ? 1 - disk.freeBytes / disk.totalBytes : 0}
              value={`${formatBytes(disk.freeBytes)} free`}
              muted={!awake}
            />
          ))}
        </View>
      ) : null}

      {machine.state === "asleep" ? (
        <View className="flex-row items-center gap-3">
          <MaterialButton
            tone="secondary"
            label="Wake"
            onPress={() =>
              void wake(machine.environmentId).then((outcome) =>
                setWakeNote(
                  outcome === "sent"
                    ? "Waking; it reconnects in about 30 seconds."
                    : "No connected machine can wake it.",
                ),
              )
            }
          />
          {wakeNote ? (
            <Text className="flex-1 text-xs text-foreground-muted">{wakeNote}</Text>
          ) : null}
        </View>
      ) : null}

      {awake ? (
        machine.agents.length === 0 ? (
          <Text className="text-xs text-foreground-muted">Idle</Text>
        ) : (
          <View className="gap-3 border-t border-separator pt-3">
            {machine.agents.map((agent) => (
              <View key={agent.threadId} className="flex-row items-center gap-2">
                <Pressable
                  className="min-w-0 flex-1 gap-0.5"
                  accessibilityRole="button"
                  onPress={() =>
                    navigation.navigate("Thread", {
                      environmentId: String(machine.environmentId),
                      threadId: String(agent.threadId),
                    })
                  }
                >
                  <Text className="text-sm text-foreground" numberOfLines={1}>
                    {agent.title}
                  </Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {agent.project} · {agent.model} · {formatSince(agent.sinceMs, now)}
                  </Text>
                  <Text
                    className={`font-mono text-xs ${agent.needsYou ? "text-warning-foreground" : agent.stuck ? "text-danger-foreground" : "text-primary-text"}`}
                    numberOfLines={1}
                  >
                    {agent.activity}
                  </Text>
                </Pressable>
                {agent.needsYou ? null : (
                  <AndroidHeaderIconButton
                    accessibilityLabel={`Stop ${agent.title}`}
                    icon="stop.fill"
                    onPress={() =>
                      void interrupt({
                        environmentId: machine.environmentId,
                        input: { threadId: agent.threadId },
                      })
                    }
                  />
                )}
              </View>
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

/** The fleet: every paired machine, its capacity, and the agents working there now. */
export function FleetRouteScreen() {
  const navigation = useNavigation();
  const machines = useAtomValue(fleetAtom);
  const totals = fleetTotals(machines);
  const [now, setNow] = useState(() => Date.now());
  const awakeIds = machines
    .filter((machine) => machine.state === "awake")
    .map((machine) => machine.environmentId)
    .join(",");

  useEffect(() => {
    const timer = setInterval(() => {
      // Backgrounded, the screen keeps its last readings instead of polling.
      if (AppState.currentState !== "active") return;
      setNow(Date.now());
      for (const environmentId of awakeIds.split(",").filter(Boolean)) {
        appAtomRegistry.refresh(
          serverEnvironment.hostResources({
            environmentId: environmentId as EnvironmentId,
            input: {},
          }),
        );
      }
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [awakeIds]);

  return (
    <View className="flex-1 bg-screen">
      <AndroidScreenHeader
        title="Fleet"
        subtitle={`${totals.awake}/${totals.machines} awake · ${totals.agents} agent${totals.agents === 1 ? "" : "s"}${totals.needsYou > 0 ? ` · ${totals.needsYou} need you` : ""}`}
        onBack={() => navigation.goBack()}
      />
      <ScrollView contentContainerClassName="gap-3 p-4">
        {machines.length === 0 ? (
          <EmptyState title="No machines yet" detail="Pair a machine in Connections." />
        ) : (
          <>
            <View className="flex-row gap-3">
              <View className="flex-1 gap-1.5 rounded-2xl bg-grouped-card p-3">
                <Text className="text-xs text-foreground-muted">CPU in use</Text>
                <Text className="text-sm text-foreground">
                  {totals.cpuBusyCores.toFixed(1)} of {totals.cpuCores} cores
                </Text>
                <Meter
                  ratio={totals.cpuCores > 0 ? totals.cpuBusyCores / totals.cpuCores : 0}
                  muted={false}
                />
              </View>
              <View className="flex-1 gap-1.5 rounded-2xl bg-grouped-card p-3">
                <Text className="text-xs text-foreground-muted">Memory in use</Text>
                <Text className="text-sm text-foreground">
                  {formatUsedOfTotal(totals.memoryUsedBytes, totals.memoryTotalBytes)}
                </Text>
                <Meter
                  ratio={
                    totals.memoryTotalBytes > 0
                      ? totals.memoryUsedBytes / totals.memoryTotalBytes
                      : 0
                  }
                  muted={false}
                />
              </View>
            </View>
            {machines.map((machine) => (
              <MachineCard key={machine.environmentId} machine={machine} now={now} />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** Header button to the fleet dashboard. */
export function FleetHeaderButton() {
  const navigation = useNavigation();
  return (
    <AndroidHeaderIconButton
      accessibilityLabel="Fleet"
      icon="server.rack"
      onPress={() => navigation.navigate("Fleet")}
    />
  );
}
