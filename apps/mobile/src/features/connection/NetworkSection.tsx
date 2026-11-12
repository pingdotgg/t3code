import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  type DeviceNetworkHostState,
  deviceNetworkHostsKey,
  refreshDeviceNetwork,
} from "@t3tools/client-runtime/state/deviceNetwork";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  appAccessLevel,
  appControls,
  canForgetOther,
  type DeviceNetworkGroup,
  type DeviceNetworkMachine,
  deviceNetworkView,
  type HostControls,
  hostControls,
  hostsListing,
  type MachineEntry,
  machineControls,
  networkFailureMessage,
  openAccessHint,
} from "@t3tools/client-runtime/tailnet-devices";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  isManagedSettingPath,
  type NetworkApp,
  type NetworkAppAccess,
  type TailnetDeviceAccess,
  type TailnetDeviceStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { type ReactNode, useContext, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironments } from "../../state/environments";
import { networkMembers } from "../../state/networkMembers";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { deviceNetwork, deviceNetworkHosts, tailnetDevices } from "../../state/tailnetDevices";
import { useAtomCommand } from "../../state/use-atom-command";
import { ACCESS_CHOICES } from "../threads/thread-settings-options";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ConnectionStatusDot, type ConnectionStatusDotState } from "./ConnectionStatusDot";

const accessLabel = (access: TailnetDeviceAccess) =>
  access === "revoked"
    ? "Revoked"
    : (ACCESS_CHOICES.find((choice) => choice.access === access)?.label ?? access);
const APP_ACCESS_LABEL: Record<NetworkAppAccess, string> = {
  "full-access": "Full access",
  "read-only": "Read only",
  revoked: "Revoked",
};
const STATUS_LABEL: Record<TailnetDeviceStatus, string> = {
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};
const STATUS_DOT: Record<TailnetDeviceStatus, ConnectionStatusDotState> = {
  online: "connected",
  offline: "available",
  revoked: "error",
};
const NEEDS_READD = "Needs re-adding after the update";
const LEFT = "Left the network";
const RECONNECTING = "Reconnecting after the update";
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const formatTime = (time: DateTime.Utc) => timeFormat.format(DateTime.toDate(time));

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
/** Its session here was refused and no connected machine can open it again. */
const refusedInApp = (left: boolean) =>
  left
    ? "Its session in this app has ended. Pair with it by code to use it here; to bring it back to the network, choose Allow joining on it, then Add again"
    : "Its session in this app ended and no machine connected here can open it again. Pair with it by code, or connect this app to a machine in its network that can open it";
/** A machine that left keeps this app's session until it ends; it is never renewed. */
const keptInApp = (until: DateTime.Utc | null, now: DateTime.Utc) =>
  until !== null && !DateTime.isGreaterThan(until, now)
    ? "Its session in this app has ended: pair with it by code to rejoin"
    : `Kept in this app until ${until === null ? "its session ends" : dateFormat.format(DateTime.toDate(until))}: to rejoin, choose Allow joining on it, then Add again before then`;

const hostLabel = (group: DeviceNetworkGroup, environmentId: EnvironmentId) =>
  group.hosts.find((host) => host.environmentId === environmentId)?.label ?? environmentId;

const joinParts = (parts: ReadonlyArray<string | null>) =>
  parts.filter((part): part is string => part !== null && part.length > 0).join(" · ");

type Settled = AtomCommandResult<unknown, unknown>;
/** Alerts with the machine's own reason on a failed write; refreshes every host after one that worked. */
const settle = (result: Settled, failureTitle: string, onChanged: () => void) => {
  if (result._tag === "Success") {
    onChanged();
    return true;
  }
  Dialog.alert(failureTitle, networkFailureMessage(squashAtomCommandFailure(result)));
  return false;
};

/** Where the joining switch lives in this app. */
const ALLOW_JOINING_PATH = "Settings → Environments → Device network";

/**
 * The one Device network view: every connected environment's roster merged, grouped by network.
 * A connected machine's own switch sits on its row in the list.
 */
export function NetworkSection() {
  const { environments, presentationById } = useEnvironments();
  const supported = environments.filter((environment) => {
    const presentation = presentationById.get(environment.environmentId);
    return (
      presentation?.connection.phase === "connected" &&
      presentation.serverConfig?.environment.capabilities.peerLinks === true
    );
  });
  const readable = useEnvironmentsWithScope(supported, AuthAccessReadScope);
  const hosts = supported.filter((environment) => readable.has(environment.environmentId));
  if (hosts.length === 0) return null;
  return (
    <DeviceNetworkContent
      hosts={hosts.map((environment) => {
        const config = presentationById.get(environment.environmentId)?.serverConfig ?? null;
        const policy = config?.managedPolicy;
        return {
          environmentId: environment.environmentId,
          label: environment.label,
          enabled: config?.settings.linkedEnvironmentsEnabled === true,
          managedBy:
            policy !== undefined && isManagedSettingPath(policy, "linkedEnvironmentsEnabled")
              ? policy.organization
              : null,
        };
      })}
    />
  );
}

function DeviceNetworkContent(props: {
  readonly hosts: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly enabled: boolean;
    readonly managedBy: string | null;
  }>;
}) {
  const states = useAtomValue(deviceNetworkHosts(deviceNetworkHostsKey(props.hosts)));
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const memberStatuses = useAtomValue(networkMembers.statusAtom);
  const groups = deviceNetworkView({
    hosts: states,
    savedEnvironmentIds: new Set(environments.map((environment) => environment.environmentId)),
    memberStatuses,
    preferredHost: null,
  });
  const onChanged = () => refreshDeviceNetwork(registry, peerLinkEnvironment.list, states);
  return (
    <View className="mt-5 gap-5">
      {groups.map((group, index) => (
        <GroupSection
          key={group.key}
          group={group}
          title={
            groups.length === 1
              ? "Device network"
              : group.inNetwork
                ? index === 0
                  ? "Your network"
                  : "Another network"
                : `${group.hosts[0]?.label ?? "Machine"}: not in a network`
          }
          hostStates={group.hosts.flatMap(
            (host) => states.find((state) => state.environmentId === host.environmentId) ?? [],
          )}
          managedBy={(id) =>
            props.hosts.find((host) => host.environmentId === id)?.managedBy ?? null
          }
          onChanged={onChanged}
        />
      ))}
    </View>
  );
}

function groupFooter(group: DeviceNetworkGroup): string {
  if (!group.inNetwork && !group.addsToNetwork) {
    return "Not in your network. Allow joining here, then add it from a full-access machine.";
  }
  if (!group.inNetwork) return "Not in a network yet: you add each machine.";
  return group.authority === null
    ? "Only a full-access machine can change the network; none is connected here."
    : "Changes go to every machine in the network.";
}

function GroupSection(props: {
  readonly group: DeviceNetworkGroup;
  readonly title: string;
  readonly hostStates: ReadonlyArray<DeviceNetworkHostState>;
  readonly managedBy: (environmentId: EnvironmentId) => string | null;
  readonly onChanged: () => void;
}) {
  const { group } = props;
  const takingPart = props.hostStates.some((host) => host.enabled);
  const hostById = new Map(props.hostStates.map((host) => [host.environmentId, host] as const));
  // A connected machine the list already shows carries its switch on that row instead.
  const listedHosts = new Set(
    takingPart
      ? group.machines.flatMap((machine) =>
          machine.entry.isHost && hostById.has(machine.entry.environmentId)
            ? [machine.entry.environmentId]
            : [],
        )
      : [],
  );
  return (
    <SettingsSection title={props.title} footer={groupFooter(group)}>
      {props.hostStates
        .filter((host) => !listedHosts.has(host.environmentId))
        .map((host) => (
          <TakingPartRow
            key={host.environmentId}
            host={host}
            managedBy={props.managedBy(host.environmentId)}
            onChanged={props.onChanged}
          />
        ))}
      {takingPart
        ? group.machines.map((machine) => {
            const host = listedHosts.has(machine.entry.environmentId)
              ? hostById.get(machine.entry.environmentId)
              : undefined;
            return (
              <MachineRow
                key={machine.key}
                group={group}
                machine={machine}
                host={
                  host === undefined
                    ? null
                    : { state: host, managedBy: props.managedBy(host.environmentId) }
                }
                onChanged={props.onChanged}
              />
            );
          })
        : null}
      {takingPart
        ? group.apps.map((app) => (
            <AppRow key={app.appId} group={group} app={app} onChanged={props.onChanged} />
          ))
        : null}
    </SettingsSection>
  );
}

function selfState(host: DeviceNetworkHostState): string {
  if (host.list === "loading") return "Loading…";
  if (host.list === "unavailable") return "Update this server to manage its network here";
  const access = host.snapshot?.selfMember?.access;
  if (access === undefined) return "Not in a network";
  if (access === "revoked") return "Out of your network";
  return `In your network, ${accessLabel(access)}`;
}

/** The one line a connected machine's row shows while closed. */
const hostSummary = (
  host: DeviceNetworkHostState,
  controls: HostControls,
  managedBy: string | null,
) =>
  joinParts([
    selfState(host),
    host.enabled ? null : "Not taking part",
    controls.joinOpenUntil === null
      ? null
      : `Joining allowed until ${formatTime(controls.joinOpenUntil)}`,
    managedBy === null ? null : `Managed by ${managedBy}`,
  ]);

/** Whether this machine takes part in the network; managed or unwritable switches are locked. */
function TakingPartSwitch(props: {
  readonly host: DeviceNetworkHostState;
  readonly managedBy: string | null;
}) {
  const { host } = props;
  const canWrite = useEnvironmentScope(host.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "network setting update",
    reportFailure: true,
  });
  return (
    <ThemedSwitch
      accessibilityLabel={`${host.label} takes part in your network`}
      disabled={props.managedBy !== null || !canWrite}
      value={host.enabled}
      onValueChange={(value) =>
        void update({
          environmentId: host.environmentId,
          input: { patch: { linkedEnvironmentsEnabled: value } },
        })
      }
    />
  );
}

/** A connected machine's own choices: joining, leaving, and what its switch does. */
function HostActions(props: {
  readonly host: DeviceNetworkHostState;
  readonly controls: HostControls;
  readonly onChanged: () => void;
}) {
  const { host, controls } = props;
  const leave = useAtomCommand(deviceNetwork.leave, { reportFailure: false });
  const allowJoin = useAtomCommand(deviceNetwork.allowJoin, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const leaveNetwork = () =>
    Dialog.confirm({
      title: `Leave your network on ${host.label}?`,
      message: `Its links to the other machines end, other apps that reach it through the network are signed out, and the others see it as left.${
        controls.lastFullAccess ? " It is the last machine in your network." : ""
      } This app keeps its connection only until that session ends, 30 days after it was issued; nothing renews it. To bring it back before then, choose Allow joining on ${host.label}, then Add again from a full-access machine. After that, pair with it by code.`,
      confirmText: "Leave",
      destructive: true,
      onConfirm: () => {
        setBusy(true);
        void leave({ environmentId: host.environmentId, input: {} }).then((result) => {
          setBusy(false);
          settle(result, `Could not leave on ${host.label}`, props.onChanged);
        });
      },
    });
  const openJoin = () => {
    setBusy(true);
    void allowJoin({ environmentId: host.environmentId, input: {} }).then((result) => {
      setBusy(false);
      settle(result, `Could not allow joining on ${host.label}`, props.onChanged);
    });
  };
  return (
    <>
      <RowNote
        text={joinParts([
          "While its switch is off, its agents start nothing over a link; running tasks finish",
          controls.leaveBlocked
            ? "Only full-access machine: it cannot leave while others remain. Give another machine full access first"
            : null,
        ])}
      />
      {controls.allowJoin && controls.joinOpenUntil === null && host.enabled ? (
        <ListActionRow
          label="Allow joining"
          description="For 10 minutes, another machine can add or link this one."
          loading={busy}
          onPress={openJoin}
        />
      ) : null}
      {controls.leave ? (
        <ListActionRow label="Leave network" tone="danger" loading={busy} onPress={leaveNetwork} />
      ) : null}
    </>
  );
}

/** A connected machine the list does not show as a machine: not in a network, or switched off. */
function TakingPartRow(props: {
  readonly host: DeviceNetworkHostState;
  readonly managedBy: string | null;
  readonly onChanged: () => void;
}) {
  const now = DateTime.makeUnsafe(useNowMinuteMs());
  const [expanded, setExpanded] = useState(false);
  const controls = hostControls(props.host, now);
  return (
    <NetworkRow
      label={props.host.label}
      detail={hostSummary(props.host, controls, props.managedBy)}
      dot={null}
      danger={false}
      trailing={<TakingPartSwitch host={props.host} managedBy={props.managedBy} />}
      canExpand
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
      <HostActions host={props.host} controls={controls} onChanged={props.onChanged} />
    </NetworkRow>
  );
}

/** Secondary detail shown once a row is open. */
function RowNote(props: { readonly text: string }) {
  if (props.text.length === 0) return null;
  return (
    <Text className="px-4 pb-3 text-xs text-foreground-muted" selectable>
      {props.text}
    </Text>
  );
}

/**
 * One row of the network list: a name, a one-line status, one trailing control, and a tap that
 * opens the rest below it.
 */
function NetworkRow(props: {
  readonly label: string;
  readonly detail: string;
  readonly dot: ConnectionStatusDotState | null;
  readonly danger: boolean;
  readonly trailing: ReactNode;
  readonly canExpand: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const toggleLabel = `${props.expanded ? "Hide" : "Show"} details for ${props.label}`;
  return (
    <View>
      <View
        className={cn(
          "min-h-14 flex-row items-center gap-3 py-2 pl-4",
          props.canExpand ? "pr-1" : "pr-4",
        )}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={toggleLabel}
          accessibilityState={{ expanded: props.expanded, disabled: !props.canExpand }}
          disabled={!props.canExpand}
          className="min-h-11 min-w-0 flex-1 justify-center gap-0.5 active:opacity-70"
          onPress={props.onToggle}
        >
          <View className="flex-row items-center gap-1.5">
            {props.dot === null ? null : (
              <ConnectionStatusDot state={props.dot} pulse={false} size={8} />
            )}
            <Text
              className="min-w-0 flex-shrink text-base font-t3-bold text-foreground"
              numberOfLines={1}
            >
              {props.label}
            </Text>
          </View>
          {props.detail.length > 0 ? (
            <Text
              className={cn(
                "text-xs",
                props.danger ? "text-danger-foreground" : "text-foreground-muted",
              )}
              numberOfLines={1}
            >
              {props.detail}
            </Text>
          ) : null}
        </Pressable>
        {props.trailing}
        {props.canExpand ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={toggleLabel}
            accessibilityState={{ expanded: props.expanded }}
            className="size-11 items-center justify-center active:opacity-70"
            onPress={props.onToggle}
          >
            <SymbolView
              name={props.expanded ? "chevron.up" : "chevron.down"}
              size={12}
              tintColorClassName="accent-icon-muted"
            />
          </Pressable>
        ) : null}
      </View>
      {props.expanded ? props.children : null}
    </View>
  );
}

const RowValue = (props: { readonly text: string }) => (
  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
    {props.text}
  </Text>
);

type Panel =
  | { readonly kind: "menu" }
  | { readonly kind: "add"; readonly scope: "network" | "local"; readonly readd?: boolean }
  | { readonly kind: "limit"; readonly host: EnvironmentId };

function machineDetail(
  group: DeviceNetworkGroup,
  machine: DeviceNetworkMachine,
  now: DateTime.Utc,
  readOnlyHere: boolean,
) {
  const { entry } = machine;
  const live = entry.member !== null && entry.member.access !== "revoked";
  return joinParts([
    STATUS_LABEL[entry.status],
    machine.kind === "found" ? "Not in your network" : null,
    ...entry.views.flatMap(({ host, device }) =>
      device.localLimit !== null && live
        ? [`Limited on ${hostLabel(group, host)} to ${accessLabel(device.localLimit)}`]
        : machine.kind === "linked" && device.outgoing === "tailnet" && device.access !== null
          ? [`Linked to ${hostLabel(group, host)} only`]
          : [],
    ),
    ...entry.links.map(({ host, link }) => {
      const health = peerLinkHealth(link, now);
      return `Paired with ${hostLabel(group, host)}${health.kind === "expired" ? ", expired" : health.kind === "reachable" ? "" : ", not answering"}`;
    }),
    entry.inApp?.kind === "open"
      ? readOnlyHere
        ? "Read-only in this app"
        : "In this app"
      : entry.inApp?.kind === "reopen"
        ? "Its session in this app ended: open it again"
        : entry.inApp?.kind === "refused"
          ? refusedInApp(entry.inApp.left)
          : null,
    // Only a known limit is shown before opening; the result shows once it is open.
    entry.inApp?.kind !== "open" &&
    !entry.isHost &&
    live &&
    openAccessHint(machine, group) === "read-only"
      ? "Opens read-only"
      : null,
    ...machine.others.map((other) => `Also seen as ${other.label} from an earlier install`),
  ]);
}

function MachineRow(props: {
  readonly group: DeviceNetworkGroup;
  readonly machine: DeviceNetworkMachine;
  /** Set when this machine is one this app is connected to: its switch sits on this row. */
  readonly host: {
    readonly state: DeviceNetworkHostState;
    readonly managedBy: string | null;
  } | null;
  readonly onChanged: () => void;
}) {
  const { group, machine, host } = props;
  const { entry } = machine;
  const controls = machineControls(machine, group);
  const readdState = controls.needsReadd ? NEEDS_READD : controls.left ? LEFT : null;
  const setAccess = useAtomCommand(tailnetDevices.setAccess, { reportFailure: false });
  const admit = useAtomCommand(tailnetDevices.admit, { reportFailure: false });
  const allowJoin = useAtomCommand(deviceNetwork.allowJoin, { reportFailure: false });
  // This app manages the machine too, so adding it from here is the owner's consent on both.
  const consentsHere = useEnvironmentScope(entry.environmentId, AuthAccessWriteScope);
  const setLimit = useAtomCommand(deviceNetwork.setLimit, { reportFailure: false });
  const forget = useAtomCommand(deviceNetwork.forget, { reportFailure: false });
  const openMember = useAtomCommand(networkMembers.open, { reportFailure: false });
  const now = DateTime.makeUnsafe(useNowMinuteMs());
  const operatesHere = useEnvironmentScope(entry.environmentId, AuthOrchestrationOperateScope);
  const navigation = useNavigation();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [saving, setSaving] = useState(false);
  const access = entry.member?.access ?? "revoked";
  const authority = group.authority;
  const hostState = host === null ? null : hostControls(host.state, now);
  const run = (work: Promise<Settled>, failureTitle: string) => {
    setSaving(true);
    void work.then((result) => {
      setSaving(false);
      if (settle(result, failureTitle, props.onChanged)) setPanel(null);
    });
  };
  const changeAccess = (next: TailnetDeviceAccess) => {
    if (authority === null || next === access) return;
    const save = () =>
      run(
        setAccess({
          environmentId: authority,
          input: { environmentId: entry.environmentId, access: next },
        }),
        `Could not change ${entry.label}'s access`,
      );
    if (next !== "revoked") return save();
    Dialog.confirm({
      title: `Revoke ${entry.label}?`,
      message:
        "It loses access on every machine in your network until a full-access machine restores it.",
      confirmText: "Revoke",
      destructive: true,
      onConfirm: save,
    });
  };
  const add = (scope: "network" | "local", level: AuthMcpClientAccess, readd: boolean) => {
    // A machine re-added after the update or a leave goes through another machine than itself.
    const via = readd ? controls.readdVia : authority;
    if (via === null) return;
    run(
      // A refused consent still lets the add say why the machine did not join.
      (consentsHere
        ? allowJoin({ environmentId: entry.environmentId, input: {} })
        : Promise.resolve()
      ).then(() =>
        admit({
          environmentId: via,
          input: { environmentId: entry.environmentId, access: level, scope },
        }),
      ),
      `Could not add ${entry.label}`,
    );
  };
  const consentNote = consentsHere
    ? `This app also manages ${entry.label}, so adding it here is its agreement too.`
    : `First open ${ALLOW_JOINING_PATH} for ${entry.label} and choose Allow joining.`;
  const forgetEntry = (target: MachineEntry, hosts: ReadonlyArray<EnvironmentId>) => {
    const [first, ...rest] = hosts;
    if (first === undefined) return;
    const member = target.member !== null && target.member.access !== "revoked";
    Dialog.confirm({
      title: `Forget ${target.label}?`,
      message: member
        ? "It is revoked on every machine in your network first, so it cannot rejoin by itself, then removed from this list."
        : "It is removed from this list and any link to it here ends. It shows up again if it is found on your tailnet.",
      confirmText: "Forget",
      destructive: true,
      onConfirm: () =>
        run(
          forget({ environmentId: first, input: { environmentId: target.environmentId } }).then(
            async (result) => {
              if (result._tag === "Success") {
                for (const host of rest) {
                  await forget({
                    environmentId: host,
                    input: { environmentId: target.environmentId },
                  });
                }
              }
              return result;
            },
          ),
          `Could not forget ${target.label}`,
        ),
    });
  };
  const open = () => run(openMember(entry.environmentId), `Could not open ${entry.label}`);
  const refused = entry.inApp?.kind === "refused";
  const addLabel = machine.inOtherNetwork
    ? "Merge networks"
    : controls.forgotten
      ? "Restore"
      : "Add to network";
  const readdLabel = machine.inOtherNetwork ? "Merge networks" : "Add again";
  // The row's one main action, matching the web row; a connected machine's switch takes its place.
  const primary = controls.readd
    ? {
        kind: "readd",
        label: readdLabel,
        onPress: () => setPanel({ kind: "add", scope: "network", readd: true }),
      }
    : controls.add || controls.promote
      ? {
          kind: "add",
          label: addLabel,
          onPress: () => setPanel({ kind: "add", scope: "network" }),
        }
      : controls.open
        ? { kind: "open", label: "Open", onPress: open }
        : controls.restore
          ? { kind: "restore", label: "Restore", onPress: () => setPanel({ kind: "menu" }) }
          : null;
  const inline = host === null ? primary : null;
  const fullDetail =
    readdState !== null
      ? controls.left && entry.inApp?.kind === "left"
        ? `${readdState}. ${keptInApp(entry.inApp.until, now)}`
        : entry.inApp?.kind === "refused"
          ? `${readdState}. ${refusedInApp(entry.inApp.left)}`
          : `${readdState}: allow joining on it, then add it again`
      : joinParts([
          controls.reconnecting ? RECONNECTING : null,
          machineDetail(group, machine, now, entry.inApp?.kind === "open" && !operatesHere),
        ]);
  const detail =
    host !== null && hostState !== null
      ? joinParts([
          readdState,
          controls.reconnecting ? RECONNECTING : null,
          hostSummary(host.state, hostState, host.managedBy),
        ])
      : joinParts([
          readdState ?? STATUS_LABEL[entry.status],
          controls.reconnecting ? RECONNECTING : null,
          machine.kind === "found" ? "Not in your network" : null,
          entry.inApp?.kind === "open"
            ? operatesHere
              ? "In this app"
              : "Read-only in this app"
            : null,
        ]);
  const authorityLabel = authority === null ? "" : hostLabel(group, authority);
  return (
    <NetworkRow
      label={entry.label}
      detail={detail}
      dot={readdState !== null ? "reconnecting" : STATUS_DOT[entry.status]}
      danger={entry.status === "revoked" || readdState !== null}
      trailing={
        host !== null ? (
          <TakingPartSwitch host={host.state} managedBy={host.managedBy} />
        ) : inline !== null ? (
          <Button
            label={inline.label}
            accessibilityLabel={`${inline.label}: ${entry.label}`}
            loading={inline.kind === "open" && saving}
            disabled={saving}
            onPress={inline.onPress}
          />
        ) : machine.kind === "member" ? (
          <RowValue text={accessLabel(access)} />
        ) : machine.kind === "linked" ? (
          <RowValue text="Linked" />
        ) : null
      }
      // Every row opens: its full status and remaining choices live below it.
      canExpand
      expanded={panel !== null}
      onToggle={() => setPanel((current) => (current === null ? { kind: "menu" } : null))}
    >
      {panel?.kind === "menu" ? (
        <>
          {host !== null && hostState !== null ? (
            <HostActions host={host.state} controls={hostState} onChanged={props.onChanged} />
          ) : null}
          <RowNote text={fullDetail} />
          {controls.open && inline?.kind !== "open" ? (
            <ListActionRow label="Open in this app" loading={saving} onPress={open} />
          ) : null}
          {refused ? (
            <ListActionRow
              label="Pair with a code"
              description="Enter its address and a pairing code from that machine."
              onPress={() => navigation.navigate("SettingsEnvironmentNew")}
            />
          ) : null}
          {controls.changeAccess || controls.restore
            ? ACCESS_CHOICES.map((choice) => (
                <ListChoiceRow
                  key={choice.access}
                  label={controls.restore ? `Restore as ${choice.label}` : choice.label}
                  description={choice.description}
                  selected={access === choice.access}
                  disabled={saving}
                  onPress={() => changeAccess(choice.access)}
                />
              ))
            : null}
          {controls.revoke ? (
            <ListActionRow
              label="Revoke everywhere"
              tone="danger"
              loading={saving}
              onPress={() => changeAccess("revoked")}
            />
          ) : null}
          {controls.readd && inline?.kind !== "readd" ? (
            <ListActionRow
              label={readdLabel}
              onPress={() => setPanel({ kind: "add", scope: "network", readd: true })}
            />
          ) : null}
          {(controls.add || controls.promote) && inline?.kind !== "add" ? (
            <ListActionRow
              label={addLabel}
              onPress={() => setPanel({ kind: "add", scope: "network" })}
            />
          ) : null}
          {controls.linkHere ? (
            <ListActionRow
              label={`Link to ${authorityLabel} only`}
              description={`Like a pairing code: only agents on ${authorityLabel} can work there.`}
              onPress={() => setPanel({ kind: "add", scope: "local" })}
            />
          ) : null}
          {controls.limitHosts.map((host) => (
            <ListActionRow
              key={host}
              label={`Only on ${hostLabel(group, host)}: limit…`}
              description="A narrower level that machine alone keeps."
              onPress={() => setPanel({ kind: "limit", host })}
            />
          ))}
          {controls.forgetHosts.length > 0 ? (
            <ListActionRow
              label="Forget"
              tone="danger"
              loading={saving}
              onPress={() => forgetEntry(entry, controls.forgetHosts)}
            />
          ) : null}
          {machine.others
            .filter((other) => canForgetOther(group, other))
            .map((other) => (
              <ListActionRow
                key={other.environmentId}
                label={`Forget earlier install ${other.label}`}
                tone="danger"
                loading={saving}
                onPress={() =>
                  forgetEntry(
                    other,
                    other.member === null || authority === null
                      ? hostsListing(group, other, authority)
                      : [
                          authority,
                          ...hostsListing(group, other, null).filter((id) => id !== authority),
                        ],
                  )
                }
              />
            ))}
        </>
      ) : null}
      {panel?.kind === "add" ? (
        <>
          <RowNote
            text={
              panel.scope === "local"
                ? consentNote
                : machine.inOtherNetwork
                  ? `${entry.label} is in another of your networks; adding it makes them one, each machine and app keeping the access it has now. ${consentNote}`
                  : panel.readd === true
                    ? consentNote
                    : `No machine in the network gives it more than the access you pick. A machine's own limit for it stays until you clear it. ${consentNote}`
            }
          />
          {ACCESS_CHOICES.map((choice) => (
            <ListChoiceRow
              key={choice.access}
              label={
                panel.scope === "network"
                  ? `${panel.readd === true ? "Add again" : "Add"} as ${choice.label}`
                  : `Link to ${authorityLabel} as ${choice.label}`
              }
              description={choice.description}
              selected={false}
              disabled={saving}
              onPress={() => add(panel.scope, choice.access, panel.readd === true)}
            />
          ))}
        </>
      ) : null}
      {panel?.kind === "limit" ? (
        <>
          <ListChoiceRow
            label="No limit"
            description="It gets its network access here too."
            selected={
              entry.views.find((view) => view.host === panel.host)?.device.localLimit == null
            }
            disabled={saving}
            onPress={() =>
              run(
                setLimit({
                  environmentId: panel.host,
                  input: { environmentId: entry.environmentId, access: null },
                }),
                `Could not clear the limit`,
              )
            }
          />
          {ACCESS_CHOICES.map((choice) => (
            <ListChoiceRow
              key={choice.access}
              label={`Limit to ${choice.label}`}
              description={choice.description}
              selected={
                entry.views.find((view) => view.host === panel.host)?.device.localLimit ===
                choice.access
              }
              disabled={saving}
              onPress={() =>
                run(
                  setLimit({
                    environmentId: panel.host,
                    input: { environmentId: entry.environmentId, access: choice.access },
                  }),
                  `Could not limit ${entry.label}`,
                )
              }
            />
          ))}
        </>
      ) : null}
    </NetworkRow>
  );
}

function AppRow(props: {
  readonly group: DeviceNetworkGroup;
  readonly app: NetworkApp;
  readonly onChanged: () => void;
}) {
  const { app, group } = props;
  const setAppAccess = useAtomCommand(tailnetDevices.setAppAccess, { reportFailure: false });
  const forgetApp = useAtomCommand(deviceNetwork.forgetApp, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const level = appAccessLevel(app.access);
  const authority = group.authority;
  const run = (work: Promise<Settled>, failureTitle: string) => {
    setSaving(true);
    void work.then((result) => {
      setSaving(false);
      if (settle(result, failureTitle, props.onChanged)) {
        setExpanded(false);
      }
    });
  };
  const controls = appControls(app, group);
  const narrow = (next: NetworkAppAccess) => {
    if (authority === null) return;
    Dialog.confirm({
      title: next === "revoked" ? `Revoke ${app.label}?` : `Make ${app.label} read-only?`,
      message:
        "It is signed out on every machine in your network and must pair again with a new link.",
      confirmText: next === "revoked" ? "Revoke" : "Make read-only",
      destructive: true,
      onConfirm: () =>
        run(
          setAppAccess({ environmentId: authority, input: { appId: app.appId, access: next } }),
          `Could not change ${app.label}'s access`,
        ),
    });
  };
  // This app cannot create pairing links, so it says where to make one.
  const pairAgain = () =>
    Dialog.alert(
      controls.pairAgain ? `Pair ${app.label} again` : `Pair ${app.label} as new`,
      controls.pairAgain
        ? `On web or desktop, open Settings → Environments → Device network and choose Pair again on ${app.label}. Open that link on ${app.label}: it replaces the old one on every machine, at the access you pick.`
        : `On web or desktop, open Settings → Environments → Device network and choose Pair as new on ${app.label}. Open that link on ${app.label}: it joins as a new app; forget this entry afterwards.`,
    );
  const forget = () => {
    if (authority === null) return;
    Dialog.confirm({
      title: `Forget ${app.label}?`,
      message: "It is removed from this list. To use it again, pair it with a new link.",
      confirmText: "Forget",
      destructive: true,
      onConfirm: () =>
        run(
          forgetApp({ environmentId: authority, input: { appId: app.appId } }),
          `Could not forget ${app.label}`,
        ),
    });
  };
  return (
    <NetworkRow
      label={app.label}
      detail={level === "revoked" ? "Signed out" : "App paired with your network"}
      dot={null}
      danger={level === "revoked"}
      trailing={<RowValue text={APP_ACCESS_LABEL[level]} />}
      canExpand={authority !== null}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
      {level === "revoked" ? (
        <RowNote text="Signed out: revoked, or paired again as a new entry" />
      ) : null}
      {controls.narrowTo.map((next) => (
        <ListActionRow
          key={next}
          label={next === "revoked" ? "Revoke everywhere" : "Make read-only"}
          tone={next === "revoked" ? "danger" : "default"}
          loading={saving}
          onPress={() => narrow(next)}
        />
      ))}
      {controls.pairAgain || controls.pairAsNew ? (
        <ListActionRow
          label={controls.pairAgain ? "Pair again" : "Pair as new"}
          description="More access, or coming back after a revoke, takes a new pairing link."
          onPress={pairAgain}
        />
      ) : null}
      {controls.forget ? (
        <ListActionRow label="Forget" tone="danger" loading={saving} onPress={forget} />
      ) : null}
    </NetworkRow>
  );
}
