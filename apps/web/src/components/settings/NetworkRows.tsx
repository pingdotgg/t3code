import { msg } from "gt-react";
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
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  appAccessLevel,
  appControls,
  type DeviceNetwork,
  type DeviceNetworkMachine,
  deviceNetworkView,
  hostControls,
  type MachineEntry,
  machineControls,
  networkFailureMessage,
  openAccessHint,
} from "@t3tools/client-runtime/tailnet-devices";
import {
  AuthMcpClientAccess,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  NETWORK_ACCESS_CEILING,
  type NetworkApp,
  type NetworkAppAccess,
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

/** Reports a failed write. */
const settle = (result: CommandResult, failureTitle: string) => {
  if (result._tag === "Success") {
    return true;
  }
  if (!isAtomCommandInterrupted(result)) failureToast(failureTitle, result);
  return false;
};

const confirmDestructive = async (message: string) =>
  (await (requestConfirmDialog(message, { variant: "destructive" }) ?? Promise.resolve(false))) ===
  true;
const ONLINE_DOT = "bg-success";
const NEUTRAL_DOT = "bg-muted-foreground/30";
const STATUS_LABEL: Record<TailnetDeviceStatus, string> = {
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};
const FOUND = "New device found on Tailscale";

const accessLabel = (access: TailnetDeviceAccess) =>
  access === "revoked" ? "Revoked" : accessConfig[access].label;
const APP_ACCESS_LABEL: Record<NetworkAppAccess, string> = {
  "full-access": "Full access",
  "read-only": "Read-only",
  revoked: "Revoked",
};

const hostLabel = (network: DeviceNetwork, environmentId: EnvironmentId) =>
  network.hosts.find((host) => host.environmentId === environmentId)?.label ?? environmentId;

function RowLayout({
  title,
  status,
  details,
  actions,
}: {
  readonly title: string;
  readonly status: { readonly label: string; readonly dot: string } | null;
  readonly details: ReadonlyArray<string | null>;
  readonly actions: ReactNode;
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
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      </div>
    </div>
  );
}

function machineDetails(
  network: DeviceNetwork,
  machine: DeviceNetworkMachine,
  /** Opened in this app and its session there cannot change anything. */
  readOnlyHere: boolean,
): ReadonlyArray<string | null> {
  const { entry } = machine;
  if (machine.kind === "found") return [FOUND, entry.tailnetName];
  const access = entry.member?.access ?? null;
  const limits = entry.views.flatMap(({ host, device }) =>
    device.localLimit === null
      ? []
      : [`Limited on ${hostLabel(network, host)} to ${accessConfig[device.localLimit].label}`],
  );
  return [
    access !== null && access !== "full-access" ? `Limited to ${accessLabel(access)}` : null,
    ...limits,
    entry.inApp?.kind === "open" && readOnlyHere ? "Read-only in this app" : null,
    // Only a known limit is shown before opening; the result shows once it is open.
    entry.inApp?.kind !== "open" &&
    !entry.isHost &&
    openAccessHint(machine, network) === "read-only"
      ? "Opens read-only"
      : null,
    entry.tailnetName,
  ];
}

/** The network controls of one machine, shared by its row whether or not it is saved here. */
export interface MachineParts {
  readonly details: ReadonlyArray<string | null>;
  /** Inline buttons: Allow. */
  readonly actions: ReactNode;
  /** Items for the row's "…" menu: access, limit, remove. */
  readonly menuItems: ReactNode;
  readonly dialogs: ReactNode;
  /** A member: auto-open would undo a removal, so it is never removed from this app. */
  readonly member: boolean;
}

/**
 * One machine's network controls, merged from every connected host. Network writes go through
 * `machineControls(...).via`; a limit goes to the host that keeps it.
 */
export function useMachineParts({
  network,
  machine,
}: {
  readonly network: DeviceNetwork;
  readonly machine: DeviceNetworkMachine;
}): MachineParts {
  const { entry } = machine;
  const controls = machineControls(machine, network);
  const operatesHere = useEnvironmentScope(entry.environmentId, AuthOrchestrationOperateScope);
  const admit = useAtomCommand(tailnetDevices.admit, { reportFailure: false });
  const setAccess = useAtomCommand(tailnetDevices.setAccess, { reportFailure: false });
  const forget = useAtomCommand(deviceNetwork.forget, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [limitHost, setLimitHost] = useState<EnvironmentId | null>(null);
  const access = entry.member?.access ?? "revoked";
  const via = controls.via;

  const allow = async () => {
    if (via === null) return;
    setBusy(true);
    // Another host may have found it, so its addresses travel with the request.
    const result = await admit({
      environmentId: via,
      input: { environmentId: entry.environmentId, urls: entry.urls },
    });
    setBusy(false);
    if (settle(result, `Could not add ${entry.label}`)) {
      toastManager.add({ type: "success", title: `Added ${entry.label} to your network` });
    }
  };

  const changeAccess = async (next: TailnetDeviceAccess) => {
    if (via === null || next === access) return;
    setBusy(true);
    const result = await setAccess({
      environmentId: via,
      input: { environmentId: entry.environmentId, access: next },
    });
    setBusy(false);
    settle(result, `Could not change ${entry.label}'s access`);
  };

  const remove = async () => {
    if (
      via === null ||
      !(await confirmDestructive(
        `Remove ${entry.label} from your network? It loses access on every machine. If it is still on your Tailscale account, it shows up here again to allow.`,
      ))
    )
      return;
    setBusy(true);
    const result = await forget({
      environmentId: via,
      input: { environmentId: entry.environmentId },
    });
    setBusy(false);
    settle(result, `Could not remove ${entry.label}`);
  };

  return {
    member: machine.kind === "member",
    details: machineDetails(network, machine, entry.inApp?.kind === "open" && !operatesHere),
    actions: controls.allow ? (
      <Button size="xs" disabled={busy} onClick={() => void allow()}>
        {busy ? "Allowing…" : "Allow"}
      </Button>
    ) : null,
    menuItems:
      controls.limitHosts.length === 0 && !controls.remove && !controls.changeAccess ? null : (
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
              Only on {hostLabel(network, host)}: limit…
            </MenuItem>
          ))}
          {controls.remove ? (
            <MenuItem variant="destructive" disabled={busy} onClick={() => void remove()}>
              Remove from network…
            </MenuItem>
          ) : null}
        </>
      ),
    dialogs:
      limitHost === null ? null : (
        <LimitDialog
          network={network}
          entry={entry}
          host={limitHost}
          onClose={() => setLimitHost(null)}
        />
      ),
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
 * here, or one found on the tailnet. Saved machines use `SavedBackendListRow`.
 */
export function DeviceMachineRow({
  network,
  machine,
  host,
}: {
  readonly network: DeviceNetwork;
  readonly machine: DeviceNetworkMachine;
  /** Set when it is a connected host, such as this machine. */
  readonly host?: { readonly state: DeviceNetworkHostState; readonly managedBy: string | null };
}) {
  const { entry } = machine;
  const parts = useMachineParts({ network, machine });
  const record = useAtomValue(networkMembers.statusAtom).get(entry.environmentId);
  const setShown = useAtomCommand(networkMembers.setShown, "machine switch");
  const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe(useNowMinute()));
  const surface = isElectron ? "app" : "browser";
  const isThisMachine = usePrimaryEnvironmentId() === entry.environmentId;
  const hostParts = useHostParts(host ?? null);
  const found = machine.kind === "found";
  const statusLine = found
    ? FOUND
    : entry.isHost
      ? "Connected"
      : unsavedStatus(entry, record, surface, nowMs);
  // Green only for a machine this app is connected to; amber while it opens.
  const status = {
    label: statusLine,
    dot:
      !found && entry.isHost && entry.status === "online"
        ? ONLINE_DOT
        : statusLine === "Connecting…"
          ? "bg-warning"
          : NEUTRAL_DOT,
  };
  const showSwitch = !found && record !== undefined && record.status !== "left";
  const hasMenu = hostParts.menuItems !== null || parts.menuItems !== null;
  return (
    <RowLayout
      title={entry.label}
      status={status}
      details={
        found
          ? parts.details
          : [
              isThisMachine ? "This machine" : null,
              entry.isHost ? null : statusLine,
              ...hostParts.details,
              ...parts.details,
            ]
      }
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
              <MenuPopup align="end">
                {hostParts.menuItems}
                {parts.menuItems}
              </MenuPopup>
            </Menu>
          ) : null}
          {parts.dialogs}
        </>
      }
    />
  );
}

const NO_LIMIT = "none";

/** A narrower level one host alone keeps for a member, or none. */
function LimitDialog({
  network,
  entry,
  host,
  onClose,
}: {
  readonly network: DeviceNetwork;
  readonly entry: MachineEntry;
  readonly host: EnvironmentId;
  readonly onClose: () => void;
}) {
  const setLimit = useAtomCommand(deviceNetwork.setLimit, { reportFailure: false });
  const current = entry.views.find((view) => view.host === host)?.device.localLimit ?? NO_LIMIT;
  const [value, setValue] = useState<AuthMcpClientAccess | typeof NO_LIMIT>(current);
  const [busy, setBusy] = useState(false);
  const label = hostLabel(network, host);
  const networkAccess = entry.member?.access ?? "revoked";
  const save = async () => {
    setBusy(true);
    const result = await setLimit({
      environmentId: host,
      input: { environmentId: entry.environmentId, access: value === NO_LIMIT ? null : value },
    });
    setBusy(false);
    if (settle(result, `Could not limit ${entry.label}`)) onClose();
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
  network,
  app,
}: {
  readonly network: DeviceNetwork;
  readonly app: NetworkApp;
}) {
  const setAppAccess = useAtomCommand(tailnetDevices.setAppAccess, { reportFailure: false });
  const forgetApp = useAtomCommand(deviceNetwork.forgetApp, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const level = appAccessLevel(app.access);
  const authority = network.authority;
  const controls = appControls(app, network);
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
    settle(result, `Could not change ${app.label}'s access`);
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
    settle(result, `Could not forget ${app.label}`);
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
              authorityLabel={hostLabel(network, authority)}
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
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    target: {
      target: "pairing link",
      unavailableMessage: msg("Clipboard API is unavailable while copying pairing link."),
      failureMessage: msg("Failed to copy pairing link to the clipboard."),
    },
  });
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
 * A connected host's own network controls: pausing its agent links, leaving.
 * Pausing belongs to that machine alone; paused, it starts nothing over a link.
 */
export function useHostParts(
  host: { readonly state: DeviceNetworkHostState; readonly managedBy: string | null } | null,
): { readonly details: ReadonlyArray<string | null>; readonly menuItems: ReactNode } {
  const environmentId = host?.state.environmentId ?? null;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, "network setting update");
  const leave = useAtomCommand(deviceNetwork.leave, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  if (host === null) return { details: [], menuItems: null };
  const { state, managedBy } = host;
  const controls = hostControls(state);

  const leaveNetwork = async () => {
    const consequence = controls.lastFullAccess ? " It is the last machine in your network." : "";
    if (
      !(await confirmDestructive(
        `Leave your network on ${state.label}? Its links to the other machines end and other apps that reach it through the network are signed out.${consequence} While it is on your Tailscale account, it shows up as a new device to allow again.`,
      ))
    )
      return;
    setBusy(true);
    const result = await leave({ environmentId: state.environmentId, input: {} });
    setBusy(false);
    settle(result, `Could not leave on ${state.label}`);
  };

  return {
    details: [
      state.list === "unavailable" ? "Update this server to manage its network here" : null,
      state.enabled ? null : "Agent links paused",
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
        {controls.leave ? (
          <MenuItem variant="destructive" disabled={busy} onClick={() => void leaveNetwork()}>
            Leave network…
          </MenuItem>
        ) : null}
      </>
    ),
  };
}

/** Every connected host's snapshot, merged into the one Device network. */
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
  const network = deviceNetworkView({
    hosts: states,
    savedEnvironmentIds: new Set(environments.map((environment) => environment.environmentId)),
    memberStatuses,
    preferredHost,
  });
  return { states, network };
}
