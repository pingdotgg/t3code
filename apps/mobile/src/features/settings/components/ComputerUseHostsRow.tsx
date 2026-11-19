import type { ComputerHostView, EnvironmentId } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { useComputerHosts } from "../../../state/computer";

/** What a connected computer can do, in the order that decides whether it is usable at all. */
function hostAbility(host: ComputerHostView, resolve: ReturnType<typeof useMessages>): string {
  if (!host.accessibility) return resolve(msg("Needs Accessibility permission on that Mac"));
  if (!host.computerUse) return resolve(msg("Fixed controls only"));
  if (!host.screenRecording) {
    return resolve(msg("Works from accessibility; screen reading is off"));
  }
  return host.busyTaskId === null
    ? resolve(msg("Ready", { $context: "a connected computer is ready to use" }))
    : resolve(msg("Running a task"));
}

/**
 * The computers the selected environments can use right now. A computer is offered only while Ada
 * is open on it, so this is also how a person checks that a host is reachable.
 */
export function ComputerUseHostsRow(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const gt = useGT();
  const m = useMessages();
  const selected = new Set(props.environmentIds);
  const hosts = useComputerHosts().filter((entry) => selected.has(entry.environmentId));
  return (
    <View className="bg-grouped-card">
      <ListRowLayout
        icon="desktopcomputer"
        label={gt("Connected computers")}
        description={
          hosts.length === 0
            ? gt(
                "None. Open Ada on the computer you want to use and allow this environment there; a computer is available only while Ada is open on it.",
              )
            : hosts
                .map(
                  (entry) =>
                    `${entry.host.name} · ${entry.environmentLabel} · ${hostAbility(entry.host, m)}`,
                )
                .join("\n")
        }
        detail={gt("{count} connected", { count: hosts.length })}
      />
    </View>
  );
}
