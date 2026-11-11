import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type DeviceNetworkHostState,
  deviceNetworkHostsKey,
  refreshDeviceNetwork,
} from "@t3tools/client-runtime/state/deviceNetwork";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  appAccessChange,
  appAccessLevel,
  canForgetOther,
  type DeviceNetworkGroup,
  type DeviceNetworkMachine,
  deviceNetworkView,
  hostControls,
  hostsListing,
  type MachineEntry,
  machineControls,
} from "@t3tools/client-runtime/tailnet-devices";
import {
  AuthAccessReadScope,
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

const hostLabel = (group: DeviceNetworkGroup, environmentId: EnvironmentId) =>
  group.hosts.find((host) => host.environmentId === environmentId)?.label ?? environmentId;

type Settled = { readonly _tag: string };
/** Alerts on a failed write and refreshes every host's links after one that worked. */
const settle = (result: Settled, failureTitle: string, onChanged: () => void) => {
  if (result._tag === "Success") {
    onChanged();
    return true;
  }
  Dialog.alert(failureTitle, "Check that the machines are online, then try again.");
  return false;
};

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
  const groups = deviceNetworkView({
    hosts: states,
    savedEnvironmentIds: new Set(environments.map((environment) => environment.environmentId)),
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
  const canOpen = props.hostStates.some((host) => host.mayOpen);
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
              canOpen={canOpen}
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
      message: `Its links to the other machines end and they see it as revoked.${
        controls.lastFullAccess
          ? " It is your network's only full-access machine: afterwards no machine can add, change or restore the others. Give another machine full access first to keep managing them."
          : ""
      } To come back, allow joining here and add it from a full-access machine.`,
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
      : `Can be added until ${formatTime(controls.joinOpenUntil)}`,
    props.managedBy === null ? null : `Managed by ${props.managedBy}`,
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
          label="Let a machine in your network add this one"
          description="For 10 minutes, a full-access machine in your network can add it."
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
  | { readonly kind: "add"; readonly scope: "network" | "local" }
  | { readonly kind: "limit"; readonly host: EnvironmentId };

function machineDetail(
  group: DeviceNetworkGroup,
  machine: DeviceNetworkMachine,
  now: DateTime.Utc,
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
    entry.savedInApp ? "In this app" : null,
    ...machine.others.map((other) => `Also seen as ${other.label} from an earlier install`),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function MachineRow(props: {
  readonly group: DeviceNetworkGroup;
  readonly machine: DeviceNetworkMachine;
  readonly canOpen: boolean;
  readonly onChanged: () => void;
}) {
  const { group, machine } = props;
  const { entry } = machine;
  const controls = machineControls(machine, group, { canOpen: props.canOpen });
  const setAccess = useAtomCommand(tailnetDevices.setAccess, { reportFailure: false });
  const admit = useAtomCommand(tailnetDevices.admit, { reportFailure: false });
  const setLimit = useAtomCommand(deviceNetwork.setLimit, { reportFailure: false });
  const forget = useAtomCommand(deviceNetwork.forget, { reportFailure: false });
  const openMember = useAtomCommand(networkMembers.open, { reportFailure: false });
  const now = DateTime.makeUnsafe(useNowMinuteMs());
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
  const add = (scope: "network" | "local", level: AuthMcpClientAccess) => {
    if (authority === null) return;
    run(
      admit({
        environmentId: authority,
        input: { environmentId: entry.environmentId, access: level, scope },
      }),
      `Could not add ${entry.label}`,
    );
  };
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
  const canExpand =
    controls.open ||
    controls.changeAccess ||
    controls.restore ||
    controls.add ||
    controls.promote ||
    controls.forgetHosts.length > 0 ||
    controls.limitHosts.length > 0 ||
    machine.others.some((other) => canForgetOther(group, other));
  const authorityLabel = authority === null ? "" : hostLabel(group, authority);
  return (
    <ExpandableRow
      label={entry.label}
      detail={machineDetail(group, machine, now)}
      danger={entry.status === "revoked"}
      value={
        machine.kind === "member"
          ? accessLabel(access)
          : machine.kind === "found"
            ? "Add"
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
          {controls.add || controls.promote ? (
            <ListActionRow
              label="Add to network"
              description="On every machine in your network, at the access you pick."
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
                  ? `Add as ${choice.label}`
                  : `Link to ${authorityLabel} as ${choice.label}`
              }
              description={choice.description}
              selected={false}
              disabled={saving}
              onPress={() => add(panel.scope, choice.access)}
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
  const run = (work: Promise<Settled>, failureTitle: string, after?: () => void) => {
    setSaving(true);
    void work.then((result) => {
      setSaving(false);
      if (settle(result, failureTitle, props.onChanged)) {
        setExpanded(false);
        after?.();
      }
    });
  };
  const choose = (next: NetworkAppAccess) => {
    if (authority === null) return;
    const change = appAccessChange(app.access, next);
    if (change === "none") return;
    const save = () =>
      run(
        setAppAccess({ environmentId: authority, input: { appId: app.appId, access: next } }),
        `Could not change ${app.label}'s access`,
        change === "pairsAgain"
          ? () =>
              Dialog.alert(
                `${app.label} must pair again`,
                "Create a pairing link with Works on all your network's machines on a full-access machine's Connections settings, and open it on that device.",
              )
          : undefined,
      );
    Dialog.confirm({
      title:
        next === "revoked"
          ? `Revoke ${app.label}?`
          : `Change ${app.label} to ${APP_ACCESS_LABEL[next]}?`,
      message:
        change === "signsOut"
          ? "It is signed out on every machine in your network and must pair again with a new link."
          : "It takes effect once the app pairs again with a new pairing link.",
      confirmText: next === "revoked" ? "Revoke" : "Change",
      destructive: change === "signsOut",
      onConfirm: save,
    });
  };
  const forget = () => {
    if (authority === null) return;
    Dialog.confirm({
      title: `Forget ${app.label}?`,
      message:
        "It is revoked on every machine in your network, then removed from this list. To use it again, pair it with a new link.",
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
      detail={level === "revoked" ? "Revoked app" : "App paired with your network"}
      danger={level === "revoked"}
      value={APP_ACCESS_LABEL[level]}
      canExpand={authority !== null}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
      {(["full-access", "read-only"] as const).map((option) => (
        <ListChoiceRow
          key={option}
          label={
            level === "revoked"
              ? `Restore as ${APP_ACCESS_LABEL[option]}`
              : APP_ACCESS_LABEL[option]
          }
          selected={level === option}
          disabled={saving}
          onPress={() => choose(option)}
        />
      ))}
      {level === "revoked" ? (
        <ListActionRow label="Forget" tone="danger" loading={saving} onPress={forget} />
      ) : (
        <ListActionRow
          label="Revoke everywhere"
          tone="danger"
          loading={saving}
          onPress={() => choose("revoked")}
        />
      )}
    </ExpandableRow>
  );
}
