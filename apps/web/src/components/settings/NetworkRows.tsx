import { useAtomValue } from "@effect/atom-react";
import { type LinkedDeviceRow, narrowsAccess } from "@t3tools/client-runtime/tailnet-devices";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthMcpClientAccess,
  type EnvironmentId,
  type NetworkApp,
  type TailnetDevice,
  type TailnetDeviceAccess,
} from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { networkMembers } from "~/state/networkMembers";
import { tailnetDevices } from "~/state/tailnetDevices";
import { useAtomCommand } from "~/state/use-atom-command";
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
  DialogTrigger,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { LinkAccessPicker } from "./LinkAccessPicker";

const failureToast = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: String(squashAtomCommandFailure(result)),
    }),
  );

const confirmDestructive = async (message: string) =>
  (await (requestConfirmDialog(message, { variant: "destructive" }) ?? Promise.resolve(false))) ===
  true;

const STATUS_DOT: Record<TailnetDevice["status"], string> = {
  online: "bg-success",
  offline: "bg-muted-foreground/30",
  revoked: "bg-destructive",
};

const accessLabel = (access: TailnetDeviceAccess) =>
  access === "revoked" ? "Revoked" : accessConfig[access].label;

/** A level picker; once revoked, picking a level restores at it. */
function NetworkAccessSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: TailnetDeviceAccess;
  readonly disabled: boolean;
  readonly onChange: (access: AuthMcpClientAccess) => void;
}) {
  const revoked = value === "revoked";
  return (
    <Select
      value={revoked ? null : value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as AuthMcpClientAccess);
      }}
    >
      <SelectTrigger size="sm" aria-label={revoked ? `Restore ${label}` : `${label} access`}>
        <SelectValue>{revoked ? "Restore as…" : accessConfig[value].label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {AuthMcpClientAccess.literals.map((option) => (
          <SelectItem key={option} value={option} hideIndicator>
            {accessConfig[option].label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

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
          <p className="text-xs text-muted-foreground">
            {details.filter((part): part is string => part !== null).join(" · ")}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      </div>
    </div>
  );
}

/** A machine in the network as `hostEnvironmentId` sees it: its access, and opening it here. */
export function NetworkMemberRow({
  hostEnvironmentId,
  row,
  canManage,
  forget,
}: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly row: LinkedDeviceRow & { readonly device: TailnetDevice };
  /** This machine may change the network, and this session may ask it to. */
  readonly canManage: boolean;
  /** Drops this environment's paired link to the device, when it has one. */
  readonly forget: ReactNode;
}) {
  const { device } = row;
  const access = device.member?.access ?? device.access ?? "revoked";
  const canOpen = useAtomValue(tailnetDevices.openDevice.permissionAtom(hostEnvironmentId));
  const setAccess = useAtomCommand(tailnetDevices.setAccess, { reportFailure: false });
  const openMember = useAtomCommand(networkMembers.open, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const revoked = access === "revoked";

  const changeAccess = async (next: TailnetDeviceAccess) => {
    if (next === access) return;
    if (
      next === "revoked" &&
      !(await confirmDestructive(
        `Revoke ${device.label}? It loses access on every machine in your network until a full-access machine restores it.`,
      ))
    )
      return;
    setBusy(true);
    const result = await setAccess({
      environmentId: hostEnvironmentId,
      input: { environmentId: device.environmentId, access: next },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast(`Could not change ${device.label}'s access`, result);
    }
  };

  const open = async () => {
    setBusy(true);
    const result = await openMember(device.environmentId);
    setBusy(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Added ${device.label} to this app` });
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast(`Could not open ${device.label}`, result);
    }
  };
  // The server opens the app with standard permissions only at full access (`TailnetDevices.ts`).
  const opensReadOnly = device.access !== "full-access";
  const statusLabel = revoked ? "Revoked" : device.status === "online" ? "Online" : "Offline";

  return (
    <RowLayout
      title={row.label}
      status={{ label: statusLabel, dot: STATUS_DOT[revoked ? "revoked" : device.status] }}
      details={[
        statusLabel,
        canManage ? null : accessLabel(access),
        device.localLimit !== null && !revoked
          ? `Limited here to ${accessConfig[device.localLimit].label}`
          : null,
        row.savedInApp ? "In this app" : null,
        !row.savedInApp && !revoked && opensReadOnly ? "Opens read-only" : null,
        device.tailnetName,
      ]}
      actions={
        <>
          {canManage ? (
            <NetworkAccessSelect
              label={device.label}
              value={access}
              disabled={busy}
              onChange={(next) => void changeAccess(next)}
            />
          ) : null}
          {!row.savedInApp && !revoked && canOpen ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void open()}>
              Open
            </Button>
          ) : null}
          {canManage && !revoked ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void changeAccess("revoked")}
            >
              Revoke
            </Button>
          ) : null}
          {forget}
        </>
      }
    />
  );
}

/** One of your machines on the tailnet that is not in the network, with adding it. */
export function FoundMachineRow({
  hostEnvironmentId,
  device,
  canManage,
}: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly device: TailnetDevice;
  readonly canManage: boolean;
}) {
  const admit = useAtomCommand(tailnetDevices.admit, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const result = await admit({
      environmentId: hostEnvironmentId,
      input: { environmentId: device.environmentId, access },
    });
    setBusy(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Added ${device.label} to your network` });
      setOpen(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast(`Could not add ${device.label}`, result);
    }
  };
  return (
    <RowLayout
      title={device.label}
      status={{
        label: device.status === "online" ? "Online" : "Offline",
        dot: STATUS_DOT[device.status],
      }}
      details={["Not in your network", device.tailnetName]}
      actions={
        canManage ? (
          <Dialog
            open={open}
            onOpenChange={(next) => {
              if (busy) return;
              setOpen(next);
              if (!next) setAccess("approval-required");
            }}
          >
            <DialogTrigger
              render={
                <Button size="xs" variant="outline">
                  Add to network
                </Button>
              }
            />
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>Add {device.label} to your network?</DialogTitle>
                <DialogDescription>
                  Being on your Tailscale account is not permission. {device.label} joins only now,
                  at the access you pick, on every machine in your network. A full-access machine
                  can narrow or revoke it later.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <LinkAccessPicker
                  value={access}
                  onChange={setAccess}
                  disabled={busy}
                  label={`What ${device.label} may do on your machines`}
                  note="Its agents and apps never get more than this on any machine in the network."
                />
              </DialogPanel>
              <DialogFooter variant="bare">
                <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
                  Cancel
                </DialogClose>
                <Button disabled={busy} onClick={() => void add()}>
                  {busy ? "Adding…" : "Add to network"}
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        ) : null
      }
    />
  );
}

/** A phone or browser paired with the whole network, and what it may do on every machine. */
export function NetworkAppRow({
  hostEnvironmentId,
  app,
  canManage,
}: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly app: NetworkApp;
  readonly canManage: boolean;
}) {
  const setAppAccess = useAtomCommand(tailnetDevices.setAppAccess, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const revoked = app.access === "revoked";
  const changeAccess = async (next: TailnetDeviceAccess) => {
    if (next === app.access) return;
    if (
      narrowsAccess(app.access, next) &&
      !(await confirmDestructive(
        next === "revoked"
          ? `Revoke ${app.label}? It is signed out on every machine in your network and must pair again to come back.`
          : `Change ${app.label} to ${accessLabel(next)}? It is signed out on every machine in your network and must pair again.`,
      ))
    )
      return;
    setBusy(true);
    const result = await setAppAccess({
      environmentId: hostEnvironmentId,
      input: { appId: app.appId, access: next },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast(`Could not change ${app.label}'s access`, result);
    }
  };
  return (
    <RowLayout
      title={app.label}
      status={null}
      details={[
        revoked ? "Revoked app" : "App paired with your network",
        canManage ? null : accessLabel(app.access),
      ]}
      actions={
        canManage ? (
          <>
            <NetworkAccessSelect
              label={app.label}
              value={app.access}
              disabled={busy}
              onChange={(next) => void changeAccess(next)}
            />
            {revoked ? null : (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void changeAccess("revoked")}
              >
                Revoke
              </Button>
            )}
          </>
        ) : null
      }
    />
  );
}
