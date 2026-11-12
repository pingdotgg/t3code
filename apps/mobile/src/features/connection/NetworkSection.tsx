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
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
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
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

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
const ALLOW_JOINING_PATH = "Settings → Environments, under Taking part";

/**
 * The one Device network view: every connected environment's roster merged, grouped by network,
 * with each machine's own switch under "Taking part".
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
    <View className="mt-5 gap-3">
      {groups.map((group, index) => (
        <GroupSection
          key={group.key}
          group={group}
          title={
            index === 0
              ? "Device network"
              : group.inNetwork
                ? "Another network"
                : `${group.hosts[0]?.label ?? "Machine"} · not in a network`
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
  const prefix =
    "Each machine has its own switch. While it is off, its agents start nothing over a link; running tasks finish.";
  if (!group.inNetwork && !group.addsToNetwork) {
    return `${prefix} Not in your network. To add it, choose Allow joining here, then add it from a full-access machine in your network.`;
  }
  if (!group.inNetwork) {
    return `${prefix} Not in a network yet. Being on the same Tailscale account is not permission: you add each machine.`;
  }
  return group.authority === null
    ? `${prefix} Only a full-access machine can change the network, and none this app may change it through is connected.`
    : `${prefix} Changes go to every machine in the network.`;
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
  return (
    <>
      <SettingsSection title={`${props.title} · Taking part`} footer={groupFooter(group)}>
        {props.hostStates.map((host) => (
          <TakingPartRow
            key={host.environmentId}
            host={host}
            managedBy={props.managedBy(host.environmentId)}
            onChanged={props.onChanged}
          />
        ))}
      </SettingsSection>
      {takingPart && group.machines.length + group.apps.length > 0 ? (
        <SettingsSection>
          {group.machines.map((machine) => (
            <MachineRow
              key={machine.key}
              group={group}
              machine={machine}
              onChanged={props.onChanged}
            />
          ))}
          {group.apps.map((app) => (
            <AppRow key={app.appId} group={group} app={app} onChanged={props.onChanged} />
          ))}
        </SettingsSection>
      ) : null}
    </>
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

function TakingPartRow(props: {
  readonly host: DeviceNetworkHostState;
  readonly managedBy: string | null;
  readonly onChanged: () => void;
}) {
  const { host } = props;
  const canWrite = useEnvironmentScope(host.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "network setting update",
    reportFailure: true,
  });
  const leave = useAtomCommand(deviceNetwork.leave, { reportFailure: false });
  const allowJoin = useAtomCommand(deviceNetwork.allowJoin, { reportFailure: false });
  const now = DateTime.makeUnsafe(useNowMinuteMs());
  const [busy, setBusy] = useState(false);
  const controls = hostControls(host, now);
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
  const subtitle = [
    selfState(host),
    controls.joinOpenUntil === null
      ? null
      : `Joining allowed until ${formatTime(controls.joinOpenUntil)}`,
    props.managedBy === null ? null : `Managed by ${props.managedBy}`,
    controls.leaveBlocked
      ? "Only full-access machine: it cannot leave while others remain. Give another machine full access first."
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return (
    <>
      <SettingsSwitchRow
        icon="link"
        label={host.label}
        subtitle={subtitle}
        value={host.enabled}
        disabled={props.managedBy !== null || !canWrite}
        onValueChange={(value) =>
          void update({
            environmentId: host.environmentId,
            input: { patch: { linkedEnvironmentsEnabled: value } },
          })
        }
      />
      {controls.allowJoin && controls.joinOpenUntil === null && host.enabled ? (
        <ListActionRow
          label="Allow joining"
          description="For 10 minutes, another machine can add this one to its network or link to it."
          loading={busy}
          onPress={openJoin}
        />
      ) : null}
      {controls.leave ? (
        <ListActionRow
          label={`Leave network on ${host.label}`}
          tone="danger"
          loading={busy}
          onPress={leaveNetwork}
        />
      ) : null}
    </>
  );
}

/** A row that opens its choices below it. */
function ExpandableRow(props: {
  readonly label: string;
  readonly detail: string;
  readonly danger: boolean;
  readonly value: string;
  readonly canExpand: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label} actions`}
        accessibilityState={{ expanded: props.expanded, disabled: !props.canExpand }}
        disabled={!props.canExpand}
        className="flex-row items-center gap-3 p-4"
        onPress={props.onToggle}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-bold text-foreground">{props.label}</Text>
          <Text
            className={
              props.danger ? "text-xs text-danger-foreground" : "text-xs text-foreground-muted"
            }
            numberOfLines={3}
          >
            {props.detail}
          </Text>
        </View>
        <Text className="text-sm text-foreground-muted">{props.value}</Text>
        {props.canExpand ? (
          <SymbolView
            name={props.expanded ? "chevron.up" : "chevron.down"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        ) : null}
      </Pressable>
      {props.expanded ? props.children : null}
    </View>
  );
}

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
  return [
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
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function MachineRow(props: {
  readonly group: DeviceNetworkGroup;
  readonly machine: DeviceNetworkMachine;
  readonly onChanged: () => void;
}) {
  const { group, machine } = props;
  const { entry } = machine;
  const controls = machineControls(machine, group);
  const readdState = controls.needsReadd
    ? "Needs re-adding after the update"
    : controls.left
      ? "Left the network"
      : null;
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
  const canExpand =
    controls.open ||
    refused ||
    controls.changeAccess ||
    controls.restore ||
    controls.add ||
    controls.promote ||
    controls.readd ||
    controls.forgetHosts.length > 0 ||
    controls.limitHosts.length > 0 ||
    machine.others.some((other) => canForgetOther(group, other));
  const authorityLabel = authority === null ? "" : hostLabel(group, authority);
  return (
    <ExpandableRow
      label={entry.label}
      detail={
        readdState !== null
          ? controls.left && entry.inApp?.kind === "left"
            ? `${readdState}. ${keptInApp(entry.inApp.until, now)}`
            : entry.inApp?.kind === "refused"
              ? `${readdState}. ${refusedInApp(entry.inApp.left)}`
              : `${readdState}: allow joining on it, then add it again`
          : [
              controls.reconnecting ? "Reconnecting after the update" : null,
              machineDetail(group, machine, now, entry.inApp?.kind === "open" && !operatesHere),
            ]
              .filter((part) => part !== null && part.length > 0)
              .join(" · ")
      }
      danger={entry.status === "revoked" || readdState !== null}
      value={
        readdState !== null
          ? "Add again"
          : machine.kind === "member"
            ? accessLabel(access)
            : machine.kind === "found"
              ? controls.forgotten
                ? "Restore"
                : "Add"
              : "Linked"
      }
      canExpand={canExpand}
      expanded={panel !== null}
      onToggle={() => setPanel((current) => (current === null ? { kind: "menu" } : null))}
    >
      {panel?.kind === "menu" ? (
        <>
          {controls.open ? (
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
          {controls.readd ? (
            <ListActionRow
              label={machine.inOtherNetwork ? "Merge networks" : "Add again"}
              description={
                machine.inOtherNetwork
                  ? `${entry.label} is in another of your networks; adding it makes them one. ${consentNote}`
                  : consentNote
              }
              onPress={() => setPanel({ kind: "add", scope: "network", readd: true })}
            />
          ) : null}
          {controls.add || controls.promote ? (
            <ListActionRow
              label={
                machine.inOtherNetwork
                  ? "Merge networks"
                  : controls.forgotten
                    ? "Restore"
                    : "Add to network"
              }
              description={
                machine.inOtherNetwork
                  ? `${entry.label} is in another of your networks; adding it makes them one, each machine and app keeping the access it has now. ${consentNote}`
                  : `No machine in the network gives it more than the access you pick. A machine's own limit for it stays until you clear it. ${consentNote}`
              }
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
      {panel?.kind === "add"
        ? ACCESS_CHOICES.map((choice) => (
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
          ))
        : null}
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
    </ExpandableRow>
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
    <ExpandableRow
      label={app.label}
      detail={
        level === "revoked"
          ? "Signed out: revoked, or paired again as a new entry"
          : "App paired with your network"
      }
      danger={level === "revoked"}
      value={APP_ACCESS_LABEL[level]}
      canExpand={authority !== null}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
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
    </ExpandableRow>
  );
}
