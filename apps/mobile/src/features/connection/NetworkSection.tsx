import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  type DeviceNetworkHostState,
  deviceNetworkHostsKey,
} from "@t3tools/client-runtime/state/deviceNetwork";
import {
  appAccessLevel,
  appControls,
  type DeviceNetwork,
  type DeviceNetworkMachine,
  deviceNetworkView,
  type HostControls,
  hostControls,
  machineControls,
  networkFailureMessage,
  openAccessHint,
} from "@t3tools/client-runtime/tailnet-devices";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { networkMemberActivityLabel, offlineSinceLabel } from "@t3tools/client-runtime/connection";
import {
  AuthAccessReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  isManagedSettingPath,
  type NetworkApp,
  type NetworkAppAccess,
  type TailnetDeviceAccess,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { type ReactNode, useState } from "react";
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
const FOUND = "New device found on Tailscale";
const HELP =
  "Ada machines on your Tailscale account show up here. Allow a new one once and every machine and app in your network can use it.";

const hostLabel = (network: DeviceNetwork, environmentId: EnvironmentId) =>
  network.hosts.find((host) => host.environmentId === environmentId)?.label ?? environmentId;

const joinParts = (parts: ReadonlyArray<string | null>) =>
  parts.filter((part): part is string => part !== null && part.length > 0).join(" · ");

type Settled = AtomCommandResult<unknown, unknown>;
/** Alerts with the machine's own reason on a failed write. */
const settle = (result: Settled, failureTitle: string) => {
  if (result._tag === "Success") {
    return true;
  }
  Dialog.alert(failureTitle, networkFailureMessage(squashAtomCommandFailure(result)));
  return false;
};

/**
 * The one Machines view: every connected environment's roster merged into the user's network.
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

function networkFooter(network: DeviceNetwork): string {
  if (network.authority !== null || !network.inNetwork) return HELP;
  // A paused machine is no authority, though it may be the full-access one.
  return `${HELP} ${
    network.hosts.some((host) => !host.enabled)
      ? "Resume agent links on a full-access machine to change the network."
      : "Only a full-access machine can change the network; none is connected here."
  }`;
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
  const { environments } = useEnvironments();
  const memberStatuses = useAtomValue(networkMembers.statusAtom);
  const network = deviceNetworkView({
    hosts: states,
    savedEnvironmentIds: new Set(environments.map((environment) => environment.environmentId)),
    memberStatuses,
    preferredHost: null,
  });
  const managedBy = (id: EnvironmentId) =>
    props.hosts.find((host) => host.environmentId === id)?.managedBy ?? null;
  const hostById = new Map(states.map((host) => [host.environmentId, host] as const));
  // A connected machine the list already shows carries its choices on that row instead.
  // Paused agent links stop agents only; the machines stay listed.
  const listedHosts = new Set(
    network.machines.flatMap((machine) =>
      machine.entry.isHost && hostById.has(machine.entry.environmentId)
        ? [machine.entry.environmentId]
        : [],
    ),
  );
  return (
    <View className="mt-5 gap-5">
      <SettingsSection title="Machines" footer={networkFooter(network)}>
        {states
          .filter((host) => !listedHosts.has(host.environmentId))
          .map((host) => (
            <TakingPartRow
              key={host.environmentId}
              host={host}
              managedBy={managedBy(host.environmentId)}
            />
          ))}
        {network.machines.map((machine) => {
          const host = listedHosts.has(machine.entry.environmentId)
            ? hostById.get(machine.entry.environmentId)
            : undefined;
          return machine.kind === "found" ? (
            <FoundRow key={machine.key} network={network} machine={machine} />
          ) : (
            <MemberRow
              key={machine.key}
              network={network}
              machine={machine}
              host={
                host === undefined
                  ? null
                  : { state: host, managedBy: managedBy(host.environmentId) }
              }
            />
          );
        })}
      </SettingsSection>
      {network.apps.length > 0 ? (
        <SettingsSection title="Phones and browsers">
          {network.apps.map((app) => (
            <AppRow key={app.appId} network={network} app={app} />
          ))}
        </SettingsSection>
      ) : null}
    </View>
  );
}

function selfState(host: DeviceNetworkHostState): string {
  if (host.list === "loading") return "Loading…";
  if (host.list === "unavailable") return "Update this server to manage its network here";
  const access = host.snapshot?.selfMember?.access;
  return access === undefined || access === "revoked" ? "Not in your network" : "Connected";
}

/** The one line a connected machine's row shows while closed. */
const hostSummary = (host: DeviceNetworkHostState, managedBy: string | null) =>
  joinParts([
    selfState(host),
    host.enabled ? null : "Agent links paused",
    managedBy === null ? null : `Managed by ${managedBy}`,
  ]);

/** A connected machine's own choices: pausing its agent links, leaving. */
function HostActions(props: {
  readonly host: DeviceNetworkHostState;
  readonly controls: HostControls;
  readonly managedBy: string | null;
}) {
  const { host, controls } = props;
  const canWrite = useEnvironmentScope(host.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "network setting update",
    reportFailure: true,
  });
  const leave = useAtomCommand(deviceNetwork.leave, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const leaveNetwork = () =>
    Dialog.confirm({
      title: `Leave your network on ${host.label}?`,
      message: `Its links to the other machines end and other apps that reach it through the network are signed out.${
        controls.lastFullAccess ? " It is the last machine in your network." : ""
      } This app keeps its connection only until that session ends. To bring it back, allow it from another machine when it shows up as a new device.`,
      confirmText: "Leave",
      destructive: true,
      onConfirm: () => {
        setBusy(true);
        void leave({ environmentId: host.environmentId, input: {} }).then((result) => {
          setBusy(false);
          settle(result, `Could not leave on ${host.label}`);
        });
      },
    });
  return (
    <>
      <RowNote
        text={joinParts([
          "While its agent links are paused, its agents start nothing over a link; running tasks finish",
          controls.leaveBlocked
            ? "Only full-access machine: it cannot leave while others remain. Give another machine full access first"
            : null,
        ])}
      />
      {props.managedBy === null && canWrite ? (
        <ListActionRow
          label={host.enabled ? "Pause agent links" : "Resume agent links"}
          onPress={() =>
            void update({
              environmentId: host.environmentId,
              input: { patch: { linkedEnvironmentsEnabled: !host.enabled } },
            })
          }
        />
      ) : null}
      {controls.leave ? (
        <ListActionRow label="Leave network" tone="danger" loading={busy} onPress={leaveNetwork} />
      ) : null}
    </>
  );
}

/** A connected machine the list does not show as a machine: not in the network, or switched off. */
function TakingPartRow(props: {
  readonly host: DeviceNetworkHostState;
  readonly managedBy: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <NetworkRow
      label={props.host.label}
      detail={hostSummary(props.host, props.managedBy)}
      dot={null}
      trailing={null}
      canExpand
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
      <HostActions
        host={props.host}
        controls={hostControls(props.host)}
        managedBy={props.managedBy}
      />
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
  readonly danger?: boolean;
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
                props.danger === true ? "text-danger-foreground" : "text-foreground-muted",
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

/** A machine on the tailnet that is not in the network: one tap allows it at full access. */
function FoundRow(props: {
  readonly network: DeviceNetwork;
  readonly machine: DeviceNetworkMachine;
}) {
  const { entry } = props.machine;
  const controls = machineControls(props.machine, props.network);
  const admit = useAtomCommand(tailnetDevices.admit, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const allow = () => {
    if (controls.via === null) return;
    setSaving(true);
    void admit({
      environmentId: controls.via,
      input: { environmentId: entry.environmentId, urls: entry.urls },
    }).then((result) => {
      setSaving(false);
      settle(result, `Could not allow ${entry.label}`);
    });
  };
  return (
    <NetworkRow
      label={entry.label}
      detail={entry.tailnetName === null ? FOUND : `${FOUND} · ${entry.tailnetName}`}
      dot="available"
      trailing={
        controls.allow ? (
          <Button
            label="Allow"
            accessibilityLabel={`Allow ${entry.label}`}
            loading={saving}
            onPress={allow}
          />
        ) : null
      }
      canExpand={false}
      expanded={false}
      onToggle={() => {}}
    >
      {null}
    </NetworkRow>
  );
}

type Panel = { readonly kind: "menu" } | { readonly kind: "limit"; readonly host: EnvironmentId };

function MemberRow(props: {
  readonly network: DeviceNetwork;
  readonly machine: DeviceNetworkMachine;
  /** Set when this machine is one this app is connected to: its switch sits on this row. */
  readonly host: {
    readonly state: DeviceNetworkHostState;
    readonly managedBy: string | null;
  } | null;
}) {
  const { network, machine, host } = props;
  const { entry } = machine;
  const controls = machineControls(machine, network);
  const setAccess = useAtomCommand(tailnetDevices.setAccess, { reportFailure: false });
  const setLimit = useAtomCommand(deviceNetwork.setLimit, { reportFailure: false });
  const forget = useAtomCommand(deviceNetwork.forget, { reportFailure: false });
  const setShown = useAtomCommand(networkMembers.setShown);
  const held = useAtomValue(networkMembers.statusAtom).get(entry.environmentId);
  const memberStatus = held?.status;
  const now = DateTime.makeUnsafe(useNowMinuteMs());
  const operatesHere = useEnvironmentScope(entry.environmentId, AuthOrchestrationOperateScope);
  const navigation = useNavigation();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [saving, setSaving] = useState(false);
  const access = entry.member?.access ?? "revoked";
  const { via } = controls;
  const run = (work: Promise<Settled>, failureTitle: string) => {
    setSaving(true);
    void work.then((result) => {
      setSaving(false);
      if (settle(result, failureTitle)) setPanel(null);
    });
  };
  const changeAccess = (next: TailnetDeviceAccess) => {
    if (via === null || next === access) return;
    run(
      setAccess({
        environmentId: via,
        input: { environmentId: entry.environmentId, access: next },
      }),
      `Could not change ${entry.label}'s access`,
    );
  };
  const remove = () => {
    if (via === null) return;
    Dialog.confirm({
      title: `Remove ${entry.label} from your network?`,
      message:
        "It loses access on every machine in your network. If it is still on your tailnet, it shows up again as a new device you can allow.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () =>
        run(
          forget({ environmentId: via, input: { environmentId: entry.environmentId } }),
          `Could not remove ${entry.label}`,
        ),
    });
  };
  const connected = entry.isHost || entry.inApp?.kind === "open";
  const refused = entry.inApp?.kind === "refused";
  const status = connected
    ? "Connected"
    : entry.status === "offline"
      ? offlineSinceLabel(
          entry.lastSeenAt === null ? null : DateTime.toEpochMillis(entry.lastSeenAt),
          DateTime.toEpochMillis(now),
        )
      : (networkMemberActivityLabel(held, "phone") ?? (refused ? "Can't connect" : "Online"));
  // An unsaved member's switch; a saved one carries it on its row in the list above.
  const showsSwitch = host === null && entry.inApp === null && memberStatus !== undefined;
  const note = joinParts([
    ...entry.views.flatMap(({ host: viewer, device }) =>
      device.localLimit === null
        ? []
        : [`Limited on ${hostLabel(network, viewer)} to ${accessLabel(device.localLimit)}`],
    ),
    entry.inApp?.kind === "open" && !operatesHere ? "Read-only in this app" : null,
    // Only a known limit is shown before opening; the result shows once it is open.
    !connected && openAccessHint(machine, network) === "read-only" ? "Opens read-only" : null,
    refused
      ? "Its session in this app ended and no machine connected here can open it again. Pair with it by code, or connect this app to another machine in your network"
      : null,
  ]);
  return (
    <NetworkRow
      label={entry.label}
      detail={host === null ? status : hostSummary(host.state, host.managedBy)}
      // Green only for a machine this app is connected to; amber only while an open runs.
      dot={
        connected && entry.status === "online"
          ? "connected"
          : memberStatus === "connecting"
            ? "connecting"
            : "available"
      }
      trailing={
        showsSwitch ? (
          <ThemedSwitch
            accessibilityLabel={`Show ${entry.label} in this app`}
            value={memberStatus !== "off"}
            onValueChange={(shown) => void setShown({ environmentId: entry.environmentId, shown })}
          />
        ) : host === null ? (
          // A connected machine's access is already in its summary line.
          <RowValue text={accessLabel(access)} />
        ) : null
      }
      // Every row opens: its full status and remaining choices live below it.
      canExpand
      expanded={panel !== null}
      onToggle={() => setPanel((current) => (current === null ? { kind: "menu" } : null))}
    >
      {panel?.kind === "menu" ? (
        <>
          {host !== null ? (
            <HostActions
              host={host.state}
              controls={hostControls(host.state)}
              managedBy={host.managedBy}
            />
          ) : null}
          <RowNote text={note} />
          {refused ? (
            <ListActionRow
              label="Pair with a code"
              description="Enter its address and a pairing code from that machine."
              onPress={() => navigation.navigate("SettingsEnvironmentNew")}
            />
          ) : null}
          {controls.changeAccess
            ? ACCESS_CHOICES.map((choice) => (
                <ListChoiceRow
                  key={choice.access}
                  label={choice.label}
                  description={choice.description}
                  selected={access === choice.access}
                  disabled={saving}
                  onPress={() => changeAccess(choice.access)}
                />
              ))
            : null}
          {controls.limitHosts.map((limitHost) => (
            <ListActionRow
              key={limitHost}
              label={`Only on ${hostLabel(network, limitHost)}: limit…`}
              description="A narrower level that machine alone keeps."
              onPress={() => setPanel({ kind: "limit", host: limitHost })}
            />
          ))}
          {controls.remove ? (
            <ListActionRow
              label="Remove from network"
              tone="danger"
              loading={saving}
              onPress={remove}
            />
          ) : null}
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

function AppRow(props: { readonly network: DeviceNetwork; readonly app: NetworkApp }) {
  const { app, network } = props;
  const setAppAccess = useAtomCommand(tailnetDevices.setAppAccess, { reportFailure: false });
  const forgetApp = useAtomCommand(deviceNetwork.forgetApp, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const level = appAccessLevel(app.access);
  const authority = network.authority;
  const run = (work: Promise<Settled>, failureTitle: string) => {
    setSaving(true);
    void work.then((result) => {
      setSaving(false);
      if (settle(result, failureTitle)) {
        setExpanded(false);
      }
    });
  };
  const controls = appControls(app, network);
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
        ? `On web or desktop, open Settings → Environments → Phones and browsers and choose Pair again on ${app.label}. Open that link on ${app.label}: it replaces the old one on every machine, at the access you pick.`
        : `On web or desktop, open Settings → Environments → Phones and browsers and choose Pair as new on ${app.label}. Open that link on ${app.label}: it joins as a new app; forget this entry afterwards.`,
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
