import { useAtomValue } from "@effect/atom-react";
import {
  type NetworkMemberState,
  networkMemberActivityLabel,
  offlineSinceLabel,
} from "@t3tools/client-runtime/connection";
import {
  type DeviceNetworkHostState,
  deviceNetworkHostsKey,
} from "@t3tools/client-runtime/state/deviceNetwork";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
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
  AuthMcpClientAccess,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  NETWORK_ACCESS_CEILING,
  type NetworkApp,
  type NetworkAppAccess,
  type PeerLinkSummary,
  type TailnetDeviceAccess,
  type TailnetDeviceStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { isElectron } from "~/env";
import { networkMembers } from "~/state/networkMembers";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { authEnvironment } from "~/state/auth";
import {
  type EnvironmentPresentation,
  useEnvironmentHttpBaseUrl,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { deviceNetwork, deviceNetworkHosts, tailnetDevices } from "~/state/tailnetDevices";
import { useAtomCommand } from "~/state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { QRCodeSvg } from "../ui/qr-code";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { LinkAccessPicker } from "./LinkAccessPicker";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

type CommandResult = AtomCommandResult<unknown, unknown>;

const failureToast = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: networkFailureMessage(squashAtomCommandFailure(result)),
    }),
  );

/** Reports a failed write, and refreshes every host's view after one that worked. */
const settle = (result: CommandResult, failureTitle: string, onChanged: () => void) => {
  if (result._tag === "Success") {
    onChanged();
    return true;
  }
  if (!isAtomCommandInterrupted(result)) failureToast(failureTitle, result);
  return false;
};

const confirmDestructive = async (message: string) =>
  (await (requestConfirmDialog(message, { variant: "destructive" }) ?? Promise.resolve(false))) ===
  true;
const STATUS_DOT: Record<TailnetDeviceStatus, string> = {
  online: "bg-success",
  offline: "bg-muted-foreground/30",
  revoked: "bg-destructive",
};
const STATUS_LABEL: Record<TailnetDeviceStatus, string> = {
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};

const accessLabel = (access: TailnetDeviceAccess) =>
  access === "revoked" ? "Revoked" : accessConfig[access].label;
const APP_ACCESS_LABEL: Record<NetworkAppAccess, string> = {
  "full-access": "Full access",
  "read-only": "Read-only",
  revoked: "Revoked",
};

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const formatTime = (time: DateTime.Utc) => timeFormat.format(DateTime.toDate(time));

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
/** Its session here was refused and no connected machine can open it again. */
const refusedInApp = (left: boolean) =>
  left
    ? "Its session in this app has ended. Pair with it by code under Add machine in Machines to use it here; to bring it back to the network, choose Allow joining on it, then Add again"
    : "Its session in this app ended and no machine connected here can open it again. Pair with it by code under Add machine in Machines, or connect this app to a machine in its network that can open it";
/** A machine that left keeps this app's session until it ends; it is never renewed. */
const keptInApp = (until: DateTime.Utc | null, now: DateTime.Utc) =>
  until !== null && !DateTime.isGreaterThan(until, now)
    ? "Its session in this app has ended: pair with it by code to rejoin"
    : `Kept in this app until ${until === null ? "its session ends" : dateFormat.format(DateTime.toDate(until))}: to rejoin, choose Allow joining on it, then Add again before then`;

const hostLabel = (group: DeviceNetworkGroup, environmentId: EnvironmentId) =>
  group.hosts.find((host) => host.environmentId === environmentId)?.label ?? environmentId;

function RowLayout({
  title,
  status,
  details,
  actions,
  children,
}: {
  readonly title: string;
  readonly status: { readonly label: string; readonly dot: string } | null;
  readonly details: ReadonlyArray<string | null>;
  readonly actions: ReactNode;
  readonly children?: ReactNode;
}) {
  const shown = details.filter((part): part is string => part !== null);
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            {status === null ? null : (
              <ConnectionStatusDot
                tooltipText={status.label}
                dotClassName={status.dot}
                pingClassName={null}
              />
            )}
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
          </div>
          {shown.length > 0 ? (
            <p className="text-xs text-muted-foreground">{shown.join(" · ")}</p>
          ) : null}
          {children}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      </div>
    </div>
  );
}

function linkStatus(link: PeerLinkSummary, now: DateTime.Utc): string {
  const health = peerLinkHealth(link, now);
  if (health.kind === "expired") return "Expired. Link it again with a new pairing code.";
  if (health.kind === "unreachable") return health.detail ?? "Not answering right now.";
  if (health.kind === "failing") return health.detail;
  return health.expiresInDays === null
    ? "Reachable"
    : `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}. Link it again to renew.`;
}

const NEEDS_READD = "Needs re-adding after the update";
const LEFT = "Left the network";
const RECONNECTING = "Reconnecting after the update";
/** Where the joining switch lives on this platform. */
const ALLOW_JOINING_PATH = "Settings → Environments → Machines";

function machineDetails(
  group: DeviceNetworkGroup,
  machine: DeviceNetworkMachine,
  now: DateTime.Utc,
  readd: "unbound" | "left" | null,
  openHint: ReturnType<typeof openAccessHint>,
  /** Opened in this app and its session there cannot change anything. */
  readOnlyHere: boolean,
  reconnecting: boolean,
): ReadonlyArray<string | null> {
  const { entry } = machine;
  if (readd !== null) {
    return [
      readd === "left" && entry.inApp?.kind === "left"
        ? `${LEFT}. ${keptInApp(entry.inApp.until, now)}`
        : entry.inApp?.kind === "refused"
          ? `${readd === "left" ? LEFT : NEEDS_READD}. ${refusedInApp(entry.inApp.left)}`
          : `${readd === "left" ? LEFT : NEEDS_READD}: allow joining on it, then add it again`,
      entry.tailnetName,
    ];
  }
  const access = entry.member?.access ?? null;
  const live = access !== null && access !== "revoked";
  const limits = entry.views.flatMap(({ host, device }) =>
    device.localLimit !== null && live
      ? [`Limited on ${hostLabel(group, host)} to ${accessConfig[device.localLimit].label}`]
      : [],
  );
  // A member's own links are how the network carries it, not something the user made.
  const links = entry.links.flatMap(({ host, link }) =>
    link.origin === "paired"
      ? [`Linked to ${hostLabel(group, host)} with a pairing code: ${linkStatus(link, now)}`]
      : [],
  );
  const localOnly = entry.views.flatMap(({ host, device }) =>
    machine.kind === "linked" && device.outgoing === "tailnet" && device.access !== null
      ? [`Linked to ${hostLabel(group, host)} only`]
      : [],
  );
  return [
    reconnecting ? RECONNECTING : null,
    machine.kind === "found" ? "Not in your network" : null,
    access !== null && access !== "revoked" && access !== "full-access"
      ? `Limited to ${accessLabel(access)}`
      : null,
    ...limits,
    ...localOnly,
    ...links,
    entry.inApp?.kind === "open" && readOnlyHere
      ? "Read-only in this app"
      : entry.inApp?.kind === "refused"
        ? refusedInApp(entry.inApp.left)
        : null,
    // Only a known limit is shown before opening; the result shows once it is open.
    entry.inApp?.kind !== "open" && !entry.isHost && live && openHint === "read-only"
      ? "Opens read-only"
      : null,
    entry.tailnetName,
  ];
}

/** The controls of one machine of a group, shared by its row whether or not it is saved here. */
export interface MachineParts {
  readonly details: ReadonlyArray<string | null>;
  /** Inline buttons: access level, Add to network, Add again, Restore. */
  readonly actions: ReactNode;
  /** Items for the row's "…" menu: limit, revoke, forget. */
  readonly menuItems: ReactNode;
  readonly dialogs: ReactNode;
  /** Other environments on the same node. */
  readonly others: ReactNode;
  readonly readd: "unbound" | "left" | null;
  /** A live member or one that left: auto-open would undo a removal, so it is never removed. */
  readonly member: boolean;
}

/**
 * One machine's network controls, merged from every connected host. Network writes go through
 * the group's authority; a limit or a forget goes to each host that keeps it.
 */
export function useMachineParts({
  group,
  machine,
  onChanged,
}: {
  readonly group: DeviceNetworkGroup;
  readonly machine: DeviceNetworkMachine;
  readonly onChanged: () => void;
}): MachineParts {
  const { entry } = machine;
  const controls = machineControls(machine, group);
  const [adding, setAdding] = useState<AddMode | null>(null);
  const operatesHere = useEnvironmentScope(entry.environmentId, AuthOrchestrationOperateScope);
  const readdReason = controls.needsReadd ? "unbound" : controls.left ? "left" : null;
  const addVia = adding === "unbound" || adding === "left" ? controls.readdVia : group.authority;
  const setAccess = useAtomCommand(tailnetDevices.setAccess, { reportFailure: false });
  const forget = useAtomCommand(deviceNetwork.forget, { reportFailure: false });
  const now = DateTime.makeUnsafe(useNowMinute());
  const [busy, setBusy] = useState(false);
  const [limitHost, setLimitHost] = useState<EnvironmentId | null>(null);
  const access = entry.member?.access ?? "revoked";
  const authority = group.authority;

  const changeAccess = async (next: TailnetDeviceAccess) => {
    if (authority === null || next === access) return;
    if (
      next === "revoked" &&
      !(await confirmDestructive(
        `Revoke ${entry.label}? It loses access on every machine in your network until a full-access machine restores it.`,
      ))
    )
      return;
    setBusy(true);
    const result = await setAccess({
      environmentId: authority,
      input: { environmentId: entry.environmentId, access: next },
    });
    setBusy(false);
    settle(result, `Could not change ${entry.label}'s access`, onChanged);
  };

  const forgetEntry = async (target: MachineEntry, hosts: ReadonlyArray<EnvironmentId>) => {
    if (hosts.length === 0) return;
    const member = target.member !== null && target.member.access !== "revoked";
    if (
      !(await confirmDestructive(
        member
          ? `Forget ${target.label}? It is revoked on every machine in your network first, so it cannot rejoin by itself, then removed from this list.`
          : `Forget ${target.label}? It is removed from this list and any link to it here ends. It shows up again if it is found on your tailnet.`,
      ))
    )
      return;
    setBusy(true);
    // The first host decides; the rest only drop it from their own lists.
    const [first, ...rest] = hosts;
    const result = await forget({
      environmentId: first!,
      input: { environmentId: target.environmentId },
    });
    if (result._tag === "Success") {
      for (const host of rest) {
        await forget({ environmentId: host, input: { environmentId: target.environmentId } });
      }
    }
    setBusy(false);
    settle(result, `Could not forget ${target.label}`, onChanged);
  };

  return {
    readd: readdReason,
    member: machine.kind === "member" && entry.member !== null && entry.member.access !== "revoked",
    details: machineDetails(
      group,
      machine,
      now,
      readdReason,
      openAccessHint(machine, group),
      entry.inApp?.kind === "open" && !operatesHere,
      controls.reconnecting,
    ),
    actions: (
      <>
        {controls.restore ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  aria-label={`Restore ${entry.label}`}
                />
              }
            >
              Restore
            </MenuTrigger>
            <MenuPopup align="end">
              {AuthMcpClientAccess.literals.map((option) => (
                <MenuItem key={option} onClick={() => void changeAccess(option)}>
                  As {accessConfig[option].label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
        {controls.add || controls.promote ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => setAdding(controls.add ? "found" : "promote")}
          >
            {machine.inOtherNetwork
              ? "Merge networks"
              : controls.forgotten
                ? "Restore"
                : "Add to network"}
          </Button>
        ) : null}
        {controls.readd ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => setAdding(readdReason ?? "unbound")}
          >
            Add again
          </Button>
        ) : null}
      </>
    ),
    menuItems:
      controls.limitHosts.length + controls.forgetHosts.length === 0 &&
      !controls.revoke &&
      !controls.changeAccess ? null : (
        <>
          {controls.changeAccess ? (
            <MenuSub>
              <MenuSubTrigger disabled={busy}>Access</MenuSubTrigger>
              <MenuSubPopup>
                <MenuRadioGroup
                  value={access}
                  onValueChange={(next) => void changeAccess(next as TailnetDeviceAccess)}
                >
                  {AuthMcpClientAccess.literals.map((option) => (
                    <MenuRadioItem key={option} value={option}>
                      {accessConfig[option].label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
          ) : null}
          {controls.limitHosts.map((host) => (
            <MenuItem key={host} disabled={busy} onClick={() => setLimitHost(host)}>
              Only on {hostLabel(group, host)}: limit…
            </MenuItem>
          ))}
          {controls.revoke ? (
            <MenuItem
              variant="destructive"
              disabled={busy}
              onClick={() => void changeAccess("revoked")}
            >
              Revoke…
            </MenuItem>
          ) : null}
          {controls.forgetHosts.length > 0 ? (
            <MenuItem
              variant="destructive"
              disabled={busy}
              onClick={() => void forgetEntry(entry, controls.forgetHosts)}
            >
              Forget…
            </MenuItem>
          ) : null}
        </>
      ),
    dialogs: (
      <>
        {adding !== null && addVia !== null ? (
          <AddMachineDialog
            group={group}
            entry={entry}
            authority={addVia}
            mode={adding}
            inOtherNetwork={machine.inOtherNetwork}
            onClose={() => setAdding(null)}
            onChanged={onChanged}
          />
        ) : null}
        {limitHost !== null ? (
          <LimitDialog
            group={group}
            entry={entry}
            host={limitHost}
            onClose={() => setLimitHost(null)}
            onChanged={onChanged}
          />
        ) : null}
      </>
    ),
    others: machine.others.map((other) => (
      <div key={other.environmentId} className="flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">
          Also on this machine: {other.label} ·{" "}
          {other.member === null ? STATUS_LABEL[other.status] : accessLabel(other.member.access)}
          {other.member === null ? "" : " member"}, from an earlier install or another server
        </span>
        {canForgetOther(group, other) ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={busy}
            onClick={() =>
              void forgetEntry(
                other,
                other.member === null || authority === null
                  ? hostsListing(group, other, authority)
                  : [
                      authority,
                      ...hostsListing(group, other, null).filter((id) => id !== authority),
                    ],
              )
            }
          >
            Forget
          </Button>
        ) : null}
      </div>
    )),
  };
}

const unsavedStatus = (
  entry: MachineEntry,
  held: NetworkMemberState | undefined,
  surface: string,
  nowMs: number,
): string => {
  if (held?.status === "off") return "Off in this app";
  if (entry.status === "offline") {
    return offlineSinceLabel(
      entry.lastSeenAt === null ? null : DateTime.toEpochMillis(entry.lastSeenAt),
      nowMs,
    );
  }
  return networkMemberActivityLabel(held, surface) ?? STATUS_LABEL[entry.status];
};

/**
 * A machine this app has no saved connection to: a member it opens by itself, one switched off
 * here, or a machine only found or linked. Saved machines use `SavedBackendListRow`.
 */
export function DeviceMachineRow({
  group,
  machine,
  host,
  onChanged,
}: {
  readonly group: DeviceNetworkGroup;
  readonly machine: DeviceNetworkMachine;
  /** Set when it is a connected host, such as this machine. */
  readonly host?: { readonly state: DeviceNetworkHostState; readonly managedBy: string | null };
  readonly onChanged: () => void;
}) {
  const { entry } = machine;
  const parts = useMachineParts({ group, machine, onChanged });
  const record = useAtomValue(networkMembers.statusAtom).get(entry.environmentId);
  const setShown = useAtomCommand(networkMembers.setShown, "machine switch");
  const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe(useNowMinute()));
  const surface = isElectron ? "app" : "browser";
  const isThisMachine = usePrimaryEnvironmentId() === entry.environmentId;
  const hostParts = useHostParts(host ?? null, onChanged);
  const statusLine = entry.isHost ? "Connected" : unsavedStatus(entry, record, surface, nowMs);
  // Green only for a machine this app is connected to; amber while it opens.
  const status =
    parts.readd !== null
      ? { label: parts.readd === "left" ? LEFT : NEEDS_READD, dot: "bg-warning" }
      : entry.status === "revoked"
        ? { label: STATUS_LABEL.revoked, dot: STATUS_DOT.revoked }
        : entry.isHost && entry.status === "online"
          ? { label: statusLine, dot: STATUS_DOT.online }
          : statusLine === "Connecting…"
            ? { label: statusLine, dot: "bg-warning" }
            : { label: statusLine, dot: STATUS_DOT.offline };
  const showSwitch = record !== undefined && record.status !== "left" && parts.readd === null;
  const menu = (
    <>
      {hostParts.menuItems}
      {parts.menuItems}
    </>
  );
  const hasMenu = hostParts.menuItems !== null || parts.menuItems !== null;
  return (
    <RowLayout
      title={entry.label}
      status={status}
      details={[
        isThisMachine ? "This machine" : null,
        parts.readd === null && !entry.isHost ? statusLine : null,
        ...hostParts.details,
        ...parts.details,
      ]}
      actions={
        <>
          {parts.actions}
          {showSwitch ? (
            <Switch
              size="sm"
              checked={record.status !== "off"}
              onCheckedChange={(checked) =>
                void setShown({ environmentId: entry.environmentId, shown: Boolean(checked) })
              }
              aria-label={`Show ${entry.label} in this app`}
            />
          ) : null}
          {hasMenu ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`More actions for ${entry.label}`}
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">{menu}</MenuPopup>
            </Menu>
          ) : null}
          {parts.dialogs}
        </>
      }
    >
      {parts.others}
    </RowLayout>
  );
}

type AddMode = "found" | "promote" | "unbound" | "left";

/**
 * Adds a found machine to the network or to the authority only, promotes a linked one, or adds
 * again a member the update left unbound.
 */
function AddMachineDialog({
  group,
  entry,
  authority,
  mode,
  inOtherNetwork,
  onClose,
  onChanged,
}: {
  readonly group: DeviceNetworkGroup;
  readonly entry: MachineEntry;
  readonly authority: EnvironmentId;
  readonly mode: AddMode;
  readonly inOtherNetwork: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const admit = useAtomCommand(tailnetDevices.admit, { reportFailure: false });
  const allowJoin = useAtomCommand(deviceNetwork.allowJoin, { reportFailure: false });
  // This app manages the machine too, so the one click is the owner's consent on both.
  const consentsHere = useEnvironmentScope(entry.environmentId, AuthAccessWriteScope);
  const [failure, setFailure] = useState<string | null>(null);
  const [scope, setScope] = useState<"network" | "local">("network");
  const previous = entry.member?.access;
  // Re-adding keeps the access it had before the update unless the user picks another. A new
  // machine starts like every other machine of the owner's: full access, which they can narrow.
  const [access, setAccess] = useState<AuthMcpClientAccess>(
    mode === "unbound" && previous !== undefined && previous !== "revoked"
      ? previous
      : "full-access",
  );
  const [busy, setBusy] = useState(false);
  const here = hostLabel(group, authority);
  const add = async () => {
    setBusy(true);
    setFailure(null);
    if (consentsHere) {
      // A refusal here still lets the add below say why the machine did not join.
      await allowJoin({ environmentId: entry.environmentId, input: {} });
    }
    const result = await admit({
      environmentId: authority,
      input: { environmentId: entry.environmentId, access, scope },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setFailure(networkFailureMessage(squashAtomCommandFailure(result)));
      return;
    }
    if (settle(result, `Could not add ${entry.label}`, onChanged)) {
      toastManager.add({
        type: "success",
        title:
          scope === "network"
            ? `Added ${entry.label} to your network`
            : `Linked ${entry.label} to ${here}`,
      });
      onClose();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "unbound" || mode === "left"
              ? `Add ${entry.label} again`
              : `Add ${entry.label}`}
          </DialogTitle>
          <DialogDescription>
            {inOtherNetwork
              ? `${entry.label} is in another of your networks. Adding it merges the two into one: every machine and app keeps the access it has now. `
              : mode === "left"
                ? `${entry.label} left your network. `
                : mode === "unbound"
                  ? `${entry.label} was in your network before the update, which now proves each machine's Tailscale identity. Until it is added again, the other machines refuse it. `
                  : `Being on your Tailscale account is not permission. ${entry.label} gets only the access you pick now. `}
            {consentsHere ? (
              `This app also manages ${entry.label}, so adding it here is its agreement too.`
            ) : (
              <>
                {`It must agree first: open ${ALLOW_JOINING_PATH} for ${entry.label} and choose `}
                <em>Allow joining</em>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {mode === "unbound" || mode === "left" ? null : mode === "promote" ? (
              <p className="text-xs text-muted-foreground">
                It is linked to one machine only today. In the network, no machine gives it more
                than the access you pick. A machine that keeps its own limit for it, such as the
                pairing-code level it was linked with, keeps that limit until you clear it.
              </p>
            ) : (
              <RadioGroup
                value={scope}
                onValueChange={(next) => setScope(next as "network" | "local")}
                disabled={busy}
              >
                <label className="flex items-start gap-2 text-xs">
                  <Radio value="network" />
                  <span>
                    <span className="block font-medium text-foreground">Add to network</span>
                    <span className="text-muted-foreground">
                      On every machine in your network. A full-access machine can narrow or revoke
                      it later.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <Radio value="local" />
                  <span>
                    <span className="block font-medium text-foreground">Link to {here} only</span>
                    <span className="text-muted-foreground">
                      Like a pairing code: only agents on {here} can work there. You can add it to
                      the network later.
                    </span>
                  </span>
                </label>
              </RadioGroup>
            )}
            <LinkAccessPicker
              value={access}
              onChange={setAccess}
              disabled={busy}
              label={
                scope === "network"
                  ? `What ${entry.label} may do on your machines`
                  : `What agents on ${here} may do there`
              }
              {...(scope === "network"
                ? {
                    note: "Its agents and apps never get more than this on any machine in the network.",
                  }
                : {})}
            />
            {failure === null ? null : (
              <p role="alert" className="text-xs text-destructive">
                {failure}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button disabled={busy} onClick={() => void add()}>
            {busy
              ? "Adding…"
              : inOtherNetwork && scope === "network"
                ? "Merge networks"
                : failure !== null
                  ? "Try again"
                  : mode === "unbound" || mode === "left"
                    ? "Add again"
                    : scope === "network"
                      ? "Add to network"
                      : `Link to ${here}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const NO_LIMIT = "none";

/** A narrower level one host alone keeps for a member, or none. */
function LimitDialog({
  group,
  entry,
  host,
  onClose,
  onChanged,
}: {
  readonly group: DeviceNetworkGroup;
  readonly entry: MachineEntry;
  readonly host: EnvironmentId;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const setLimit = useAtomCommand(deviceNetwork.setLimit, { reportFailure: false });
  const current = entry.views.find((view) => view.host === host)?.device.localLimit ?? NO_LIMIT;
  const [value, setValue] = useState<AuthMcpClientAccess | typeof NO_LIMIT>(current);
  const [busy, setBusy] = useState(false);
  const label = hostLabel(group, host);
  const networkAccess = entry.member?.access ?? "revoked";
  const save = async () => {
    setBusy(true);
    const result = await setLimit({
      environmentId: host,
      input: { environmentId: entry.environmentId, access: value === NO_LIMIT ? null : value },
    });
    setBusy(false);
    if (settle(result, `Could not limit ${entry.label}`, onChanged)) onClose();
  };
  const options = [NO_LIMIT, ...AuthMcpClientAccess.literals] as const;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Only on {label}: limit {entry.label}
          </DialogTitle>
          <DialogDescription>
            {label} alone keeps this limit. Every other machine still gives {entry.label} its
            network access, {accessLabel(networkAccess)}. A limit wider than that changes nothing.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Select
            value={value}
            disabled={busy}
            onValueChange={(next) => {
              if (next !== null) setValue(next);
            }}
          >
            <SelectTrigger aria-label={`Limit on ${label}`}>
              <SelectValue>
                {value === NO_LIMIT ? "No limit" : accessConfig[value].label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {options.map((option) => (
                <SelectItem key={option} value={option} hideIndicator>
                  {option === NO_LIMIT ? "No limit" : accessConfig[option].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button disabled={busy || value === current} onClick={() => void save()}>
            {busy ? "Saving…" : value === NO_LIMIT ? "Clear limit" : "Limit"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A phone or browser paired with the whole network. Apps are full access or read-only: narrowing
 * signs the app out everywhere; more access comes only from pairing again, which replaces it.
 */
export function NetworkAppRow({
  group,
  app,
  onChanged,
}: {
  readonly group: DeviceNetworkGroup;
  readonly app: NetworkApp;
  readonly onChanged: () => void;
}) {
  const setAppAccess = useAtomCommand(tailnetDevices.setAppAccess, { reportFailure: false });
  const forgetApp = useAtomCommand(deviceNetwork.forgetApp, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const level = appAccessLevel(app.access);
  const authority = group.authority;
  const controls = appControls(app, group);
  const narrow = async (next: NetworkAppAccess) => {
    if (
      authority === null ||
      !(await confirmDestructive(
        next === "revoked"
          ? `Revoke ${app.label}? It is signed out on every machine in your network. Pair it again to bring it back.`
          : `Make ${app.label} read-only? It is signed out on every machine in your network and must pair again.`,
      ))
    )
      return;
    setBusy(true);
    const result = await setAppAccess({
      environmentId: authority,
      input: { appId: app.appId, access: next },
    });
    setBusy(false);
    settle(result, `Could not change ${app.label}'s access`, onChanged);
  };
  const forget = async () => {
    if (
      authority === null ||
      !(await confirmDestructive(
        `Forget ${app.label}? It is removed from this list. To use it again, pair it with a new link.`,
      ))
    )
      return;
    setBusy(true);
    const result = await forgetApp({ environmentId: authority, input: { appId: app.appId } });
    setBusy(false);
    settle(result, `Could not forget ${app.label}`, onChanged);
  };
  return (
    <RowLayout
      title={app.label}
      status={null}
      details={[
        level === "revoked"
          ? "Signed out: revoked, or paired again as a new entry"
          : "App paired with your network",
        APP_ACCESS_LABEL[level],
      ]}
      actions={
        <>
          {controls.narrowTo.includes("read-only") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void narrow("read-only")}
            >
              Make read-only
            </Button>
          ) : null}
          {controls.pairAgain || controls.pairAsNew ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setPairing(true)}>
              {controls.pairAgain ? "Pair again…" : "Pair as new…"}
            </Button>
          ) : null}
          {controls.narrowTo.includes("revoked") ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void narrow("revoked")}
            >
              Revoke
            </Button>
          ) : null}
          {controls.forget ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void forget()}
            >
              Forget
            </Button>
          ) : null}
          {pairing && authority !== null ? (
            <PairAgainDialog
              app={app}
              replaces={controls.pairAgain}
              authority={authority}
              authorityLabel={hostLabel(group, authority)}
              onClose={() => setPairing(false)}
            />
          ) : null}
        </>
      }
    />
  );
}

/**
 * Makes a network pairing link that replaces `app` everywhere once redeemed, at the level picked.
 * The only way to give an app more access: its sessions keep the scopes they were minted with.
 */
function PairAgainDialog({
  app,
  replaces,
  authority,
  authorityLabel,
  onClose,
}: {
  readonly app: NetworkApp;
  /** The authority still lists it, so the link replaces it; otherwise it pairs as a new app. */
  readonly replaces: boolean;
  readonly authority: EnvironmentId;
  readonly authorityLabel: string;
  readonly onClose: () => void;
}) {
  const createPairingCredential = useAtomCommand(authEnvironment.createPairingCredential, {
    reportFailure: false,
  });
  const baseUrl = useEnvironmentHttpBaseUrl(authority);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: "pairing link" });
  const [level, setLevel] = useState<"full-access" | "read-only">("full-access");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    const input = {
      label: app.label,
      scopes: NETWORK_ACCESS_CEILING[level].app,
      network: true,
      // Redeeming removes the old app everywhere and adds this one in its place.
      ...(replaces ? { replacesAppId: app.appId } : {}),
    };
    const result = await createPairingCredential({ environmentId: authority, input });
    setBusy(false);
    if (result._tag === "Success") {
      const credential = result.value.credential;
      setUrl(
        baseUrl === null
          ? credential
          : (resolveHostedPairingUrl(baseUrl, credential) ??
              resolveDesktopPairingUrl(baseUrl, credential)),
      );
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not create a link for ${app.label}`,
          // The server reports an app it no longer lists only as a failed issue.
          description: replaces
            ? `${authorityLabel} may no longer list ${app.label}, for example after it was paired again or forgotten. Choose Pair as new once the list updates, or create a pairing link under Connections.`
            : networkFailureMessage(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pair {app.label} again</DialogTitle>
          <DialogDescription>
            Open this link on {app.label}.{" "}
            {replaces
              ? `Once it pairs, it replaces the old ${app.label} on every machine in your network, at the access you pick.`
              : `It pairs as a new app of your network, at the access you pick. Forget the old entry when it is no longer needed.`}{" "}
            The link comes from {authorityLabel}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {url === null ? (
            <RadioGroup
              value={level}
              onValueChange={(next) => setLevel(next as "full-access" | "read-only")}
              disabled={busy}
            >
              <label className="flex items-start gap-2 text-xs">
                <Radio value="full-access" />
                <span className="font-medium text-foreground">Full access</span>
              </label>
              <label className="flex items-start gap-2 text-xs">
                <Radio value="read-only" />
                <span className="font-medium text-foreground">Read-only</span>
              </label>
            </RadioGroup>
          ) : (
            <div className="flex flex-col items-center gap-3">
              {url.startsWith("http") ? (
                <QRCodeSvg value={url} size={168} level="M" marginSize={2} />
              ) : null}
              <Input value={url} readOnly nativeInput aria-label="Pairing link" />
            </div>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            {url === null ? "Cancel" : "Done"}
          </DialogClose>
          {url === null ? (
            <Button disabled={busy} onClick={() => void create()}>
              {busy ? "Creating…" : "Create link"}
            </Button>
          ) : (
            <Button onClick={() => copyToClipboard(url)}>{isCopied ? "Copied" : "Copy"}</Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A connected host's own network controls: pausing its agent links, allowing a join, leaving.
 * Pausing belongs to that machine alone; paused, it starts nothing over a link.
 */
export function useHostParts(
  host: { readonly state: DeviceNetworkHostState; readonly managedBy: string | null } | null,
  onChanged: () => void,
): { readonly details: ReadonlyArray<string | null>; readonly menuItems: ReactNode } {
  const environmentId = host?.state.environmentId ?? null;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, "network setting update");
  const leave = useAtomCommand(deviceNetwork.leave, { reportFailure: false });
  const allowJoin = useAtomCommand(deviceNetwork.allowJoin, { reportFailure: false });
  const now = DateTime.makeUnsafe(useNowMinute());
  const [busy, setBusy] = useState(false);
  if (host === null) return { details: [], menuItems: null };
  const { state, managedBy } = host;
  const controls = hostControls(state, now);

  const leaveNetwork = async () => {
    const consequence = controls.lastFullAccess ? " It is the last machine in your network." : "";
    if (
      !(await confirmDestructive(
        `Leave your network on ${state.label}? Its links to the other machines end, other apps that reach it through the network are signed out, and the others see it as left.${consequence} This app keeps its connection only until that session ends, 30 days after it was issued; nothing renews it. To bring it back before then, choose Allow joining on ${state.label}, then Add again from a full-access machine. After that, pair with it by code.`,
      ))
    )
      return;
    setBusy(true);
    const result = await leave({ environmentId: state.environmentId, input: {} });
    setBusy(false);
    settle(result, `Could not leave on ${state.label}`, onChanged);
  };

  const openJoin = async () => {
    setBusy(true);
    const result = await allowJoin({ environmentId: state.environmentId, input: {} });
    setBusy(false);
    settle(result, `Could not allow joining on ${state.label}`, onChanged);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `${state.label} can be added or linked until ${formatTime(result.value.openUntil)}`,
        description: "Add or link it from another machine before then.",
      });
    }
  };

  return {
    details: [
      state.list === "unavailable" ? "Update this server to manage its network here" : null,
      state.enabled ? null : "Agent links paused",
      controls.joinOpenUntil === null
        ? null
        : `Joining allowed until ${formatTime(controls.joinOpenUntil)}`,
      managedBy === null ? null : `Managed by ${managedBy}`,
      controls.leaveBlocked
        ? "It is your network's only full-access machine, so it cannot leave while others remain. Give another machine full access first."
        : null,
    ],
    menuItems: (
      <>
        <MenuItem
          disabled={busy || !canWriteSettings || managedBy !== null}
          onClick={() =>
            void update({
              environmentId: state.environmentId,
              input: { patch: { linkedEnvironmentsEnabled: !state.enabled } },
            })
          }
        >
          {state.enabled ? "Pause agent links" : "Resume agent links"}
        </MenuItem>
        {controls.allowJoin && controls.joinOpenUntil === null && state.enabled ? (
          <MenuItem disabled={busy} onClick={() => void openJoin()}>
            Allow joining
          </MenuItem>
        ) : null}
        {controls.leave ? (
          <MenuItem variant="destructive" disabled={busy} onClick={() => void leaveNetwork()}>
            Leave network…
          </MenuItem>
        ) : null}
      </>
    ),
  };
}

/** Every connected host's snapshot, merged into the Device network groups. */
export function useDeviceNetworkView(hosts: ReadonlyArray<EnvironmentPresentation>) {
  const states = useAtomValue(
    deviceNetworkHosts(
      deviceNetworkHostsKey(
        hosts.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          enabled: environment.serverConfig?.settings.linkedEnvironmentsEnabled === true,
        })),
      ),
    ),
  );
  const preferredHost = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const memberStatuses = useAtomValue(networkMembers.statusAtom);
  const groups = deviceNetworkView({
    hosts: states,
    savedEnvironmentIds: new Set(environments.map((environment) => environment.environmentId)),
    memberStatuses,
    preferredHost,
  });
  return { states, groups };
}
