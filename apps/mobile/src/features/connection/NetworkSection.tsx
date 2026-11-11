import { useAtomValue } from "@effect/atom-react";
import {
  canManageNetwork,
  isTailnetDevicesForbidden,
  narrowsAccess,
  networkRows,
} from "@t3tools/client-runtime/tailnet-devices";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import { useFocusEffect } from "@react-navigation/native";
import {
  AuthAccessReadScope,
  AuthSettingsWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  isManagedSettingPath,
  type NetworkApp,
  type TailnetDevice,
  type TailnetDeviceAccess,
  type TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { type ReactNode, useCallback, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { useEnvironmentServerConfig } from "../../state/entities";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { tailnetDevices } from "../../state/tailnetDevices";
import { useAtomCommand } from "../../state/use-atom-command";
import { ACCESS_CHOICES } from "../threads/thread-settings-options";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

const accessLabel = (access: TailnetDeviceAccess) =>
  access === "revoked"
    ? "Revoked"
    : (ACCESS_CHOICES.find((choice) => choice.access === access)?.label ?? access);

/**
 * One machine's place in your device network, and its links made with a pairing code. Its switch
 * is the one gate for the machine taking part; off, nothing else shows.
 */
export function NetworkSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const config = useEnvironmentServerConfig(props.environmentId);
  const canRead = useEnvironmentScope(props.environmentId, AuthAccessReadScope);
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "network setting update",
    reportFailure: true,
  });
  if (!canRead || config?.environment.capabilities.peerLinks !== true) return null;
  const enabled = config.settings.linkedEnvironmentsEnabled;
  const policy = config.managedPolicy;
  const managed = isManagedSettingPath(policy, "linkedEnvironmentsEnabled");
  return (
    <View className="mt-5 gap-3">
      <SettingsSection
        title={`Device network · ${props.environmentLabel}`}
        footer="Agents here can work on your other machines, and theirs here. While off, nothing new starts over a link; running tasks finish."
      >
        <SettingsSwitchRow
          icon="link"
          label="Take part in your network"
          {...(managed ? { subtitle: `Managed by ${policy?.organization}.` } : {})}
          value={enabled}
          disabled={managed || !canWrite}
          onValueChange={(value) =>
            void updateSettings({
              environmentId: props.environmentId,
              input: { patch: { linkedEnvironmentsEnabled: value } },
            })
          }
        />
      </SettingsSection>
      {enabled ? <NetworkContent environmentId={props.environmentId} /> : null}
    </View>
  );
}

function selfDescription(snapshot: TailnetDevicesSnapshot, foundCount: number): string {
  const access = snapshot.selfMember?.access;
  if (access === undefined) {
    return foundCount > 0
      ? "Not in a network yet. Machines join only when you add them; adding one starts your network with this machine at full access."
      : "Not in a network yet. Your other machines on Tailscale show up here once they run T3 Code. Being on the same Tailscale account is not permission: you add each one.";
  }
  if (access === "revoked") {
    return "Revoked. This machine is out of your network until a full-access machine restores it.";
  }
  return access === "full-access"
    ? "In your network with full access. You can add machines and change what each may do."
    : `In your network as ${accessLabel(access)}. Only a full-access machine can change the network.`;
}

function NetworkContent(props: { readonly environmentId: EnvironmentId }) {
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId: props.environmentId, input: {} }),
  );
  const devices = useEnvironmentQuery(
    tailnetDevices.list({ environmentId: props.environmentId, input: {} }),
  );
  const mayChange = useAtomValue(tailnetDevices.setAccess.permissionAtom(props.environmentId));
  const [nowMs, setNowMs] = useState(Date.now);
  const hasLinks = (links.data?.links.length ?? 0) > 0;
  useFocusEffect(
    useCallback(() => {
      if (!hasLinks) return;
      const updateNow = () => setNowMs(Date.now());
      updateNow();
      const timer = setInterval(updateNow, 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") updateNow();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, [hasLinks]),
  );
  // Older servers, and this one until it can list devices, fail the list; that is not an error.
  const devicesUnavailable = devices.error !== null && !isTailnetDevicesForbidden(devices.failure);
  const snapshot = devices.data;
  const rows = networkRows({
    devices: snapshot?.devices ?? [],
    links: links.data?.links ?? [],
    savedEnvironmentIds: new Set(),
  });
  const canManage = mayChange && snapshot !== null && canManageNetwork(snapshot);
  const now = DateTime.makeUnsafe(nowMs);
  const empty =
    rows.members.length + rows.found.length + rows.paired.length + (snapshot?.apps.length ?? 0) ===
    0;
  return (
    <>
      {snapshot ? (
        <Text className="px-2 text-sm text-foreground-muted">
          {selfDescription(snapshot, rows.found.length)}
        </Text>
      ) : null}
      {empty ? null : (
        <SettingsSection>
          {rows.members.map(({ device }) => (
            <MemberRow
              key={device.environmentId}
              hostEnvironmentId={props.environmentId}
              device={device}
              canManage={canManage}
            />
          ))}
          {rows.found.map((device) => (
            <FoundRow
              key={device.environmentId}
              hostEnvironmentId={props.environmentId}
              device={device}
              canManage={canManage}
            />
          ))}
          {(snapshot?.apps ?? []).map((app) => (
            <AppRow
              key={app.appId}
              hostEnvironmentId={props.environmentId}
              app={app}
              canManage={canManage}
            />
          ))}
          {rows.paired.map(({ link }) => {
            if (link === null) return null;
            const health = peerLinkHealth(link, now);
            const status =
              health.kind === "expired"
                ? "Expired. Link it again with a new pairing code."
                : health.kind === "unreachable"
                  ? (health.detail ?? "Not answering right now.")
                  : health.kind === "failing"
                    ? health.detail
                    : health.expiresInDays !== null
                      ? `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}`
                      : "Paired · Reachable";
            return (
              <View key={link.environmentId} className="gap-0.5 p-4">
                <Text className="text-base font-t3-bold text-foreground">{link.label}</Text>
                <Text
                  className={
                    health.kind === "reachable" && health.expiresInDays === null
                      ? "text-xs text-foreground-muted"
                      : "text-xs text-danger-foreground"
                  }
                  numberOfLines={2}
                >
                  {status}
                </Text>
              </View>
            );
          })}
        </SettingsSection>
      )}
      {devicesUnavailable ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Your network is not available on this server yet.
        </Text>
      ) : null}
    </>
  );
}

const DEVICE_STATUS: Record<TailnetDevice["status"], string> = {
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};

/** A row that opens its choices below it when this machine may change them. */
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
        accessibilityLabel={`${props.label} access`}
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
            numberOfLines={1}
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

/** Each level, then Revoked; once revoked, picking a level restores at it. */
function AccessChoices(props: {
  readonly value: TailnetDeviceAccess;
  readonly disabled: boolean;
  readonly revokedDescription: string;
  readonly onChoose: (access: TailnetDeviceAccess) => void;
}) {
  const revoked = props.value === "revoked";
  return (
    <>
      {ACCESS_CHOICES.map((choice) => (
        <ListChoiceRow
          key={choice.access}
          label={revoked ? `Restore as ${choice.label}` : choice.label}
          description={choice.description}
          selected={props.value === choice.access}
          disabled={props.disabled}
          onPress={() => props.onChoose(choice.access)}
        />
      ))}
      <ListChoiceRow
        label="Revoked"
        description={props.revokedDescription}
        selected={revoked}
        disabled={props.disabled}
        onPress={() => props.onChoose("revoked")}
      />
    </>
  );
}

function MemberRow(props: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly device: TailnetDevice;
  readonly canManage: boolean;
}) {
  const { device } = props;
  const access = device.member?.access ?? device.access ?? "revoked";
  const setAccess = useAtomCommand(tailnetDevices.setAccess, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = (next: TailnetDeviceAccess) => {
    setSaving(true);
    void setAccess({
      environmentId: props.hostEnvironmentId,
      input: { environmentId: device.environmentId, access: next },
    }).then((result) => {
      setSaving(false);
      if (result._tag === "Failure") {
        Dialog.alert(`Could not change ${device.label}'s access`, "Try again in a moment.");
      } else {
        setExpanded(false);
      }
    });
  };
  const choose = (next: TailnetDeviceAccess) => {
    if (next === access) return;
    if (next !== "revoked") return save(next);
    Dialog.confirm({
      title: `Revoke ${device.label}?`,
      message:
        "It loses access on every machine in your network until a full-access machine restores it.",
      confirmText: "Revoke",
      destructive: true,
      onConfirm: () => save("revoked"),
    });
  };
  return (
    <ExpandableRow
      label={device.label}
      detail={[
        DEVICE_STATUS[access === "revoked" ? "revoked" : device.status],
        device.localLimit !== null && access !== "revoked"
          ? `Limited here to ${accessLabel(device.localLimit)}`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ")}
      danger={access === "revoked"}
      value={accessLabel(access)}
      canExpand={props.canManage}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
      <AccessChoices
        value={access}
        disabled={saving}
        revokedDescription="No access on any machine in your network until a full-access machine restores it."
        onChoose={choose}
      />
    </ExpandableRow>
  );
}

function FoundRow(props: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly device: TailnetDevice;
  readonly canManage: boolean;
}) {
  const { device } = props;
  const admit = useAtomCommand(tailnetDevices.admit, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const add = (access: AuthMcpClientAccess) => {
    setSaving(true);
    void admit({
      environmentId: props.hostEnvironmentId,
      input: { environmentId: device.environmentId, access },
    }).then((result) => {
      setSaving(false);
      if (result._tag === "Failure") {
        Dialog.alert(`Could not add ${device.label}`, "Check that it is online, then try again.");
      } else {
        setExpanded(false);
      }
    });
  };
  const choose = (access: AuthMcpClientAccess) =>
    Dialog.confirm({
      title: `Add ${device.label} to your network?`,
      message: `Being on your Tailscale account is not permission. It joins now as ${accessLabel(access)} on every machine in your network. A full-access machine can narrow or revoke it later.`,
      confirmText: "Add",
      onConfirm: () => add(access),
    });
  return (
    <ExpandableRow
      label={device.label}
      detail={`${DEVICE_STATUS[device.status]} · Not in your network`}
      danger={false}
      value={props.canManage ? "Add" : ""}
      canExpand={props.canManage}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
      {ACCESS_CHOICES.map((choice) => (
        <ListChoiceRow
          key={choice.access}
          label={`Add as ${choice.label}`}
          description={choice.description}
          selected={false}
          disabled={saving}
          onPress={() => choose(choice.access)}
        />
      ))}
    </ExpandableRow>
  );
}

function AppRow(props: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly app: NetworkApp;
  readonly canManage: boolean;
}) {
  const { app } = props;
  const setAppAccess = useAtomCommand(tailnetDevices.setAppAccess, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = (next: TailnetDeviceAccess) => {
    setSaving(true);
    void setAppAccess({
      environmentId: props.hostEnvironmentId,
      input: { appId: app.appId, access: next },
    }).then((result) => {
      setSaving(false);
      if (result._tag === "Failure") {
        Dialog.alert(`Could not change ${app.label}'s access`, "Try again in a moment.");
      } else {
        setExpanded(false);
      }
    });
  };
  const choose = (next: TailnetDeviceAccess) => {
    if (next === app.access) return;
    if (!narrowsAccess(app.access, next)) return save(next);
    Dialog.confirm({
      title: next === "revoked" ? `Revoke ${app.label}?` : `Change ${app.label}?`,
      message:
        "It is signed out on every machine in your network and must pair again with a new link.",
      confirmText: next === "revoked" ? "Revoke" : "Change",
      destructive: true,
      onConfirm: () => save(next),
    });
  };
  return (
    <ExpandableRow
      label={app.label}
      detail={app.access === "revoked" ? "Revoked app" : "App paired with your network"}
      danger={app.access === "revoked"}
      value={accessLabel(app.access)}
      canExpand={props.canManage}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
      <AccessChoices
        value={app.access}
        disabled={saving}
        revokedDescription="Signed out on every machine in your network; it must pair again."
        onChoose={choose}
      />
    </ExpandableRow>
  );
}
