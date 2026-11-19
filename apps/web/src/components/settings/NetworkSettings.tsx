import { useAtomValue } from "@effect/atom-react";
import { ANOTHER_ADDRESS, linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import { type DeviceNetworkHostState } from "@t3tools/client-runtime/state/deviceNetwork";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DeviceNetwork, DeviceNetworkMachine } from "@t3tools/client-runtime/tailnet-devices";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  isManagedSettingPath,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

import { networkMemberActivityLabel } from "@t3tools/client-runtime/connection";
import { isElectron } from "~/env";
import { networkMembers } from "~/state/networkMembers";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines, useNetworkHosts } from "~/state/peerLinks";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { LinkAccessPicker } from "./LinkAccessPicker";
import { LinkAddressWarning, LinkMachineSelect } from "./LinkMachineSelect";
import {
  DeviceMachineRow,
  NetworkAppRow,
  useDeviceNetworkView,
  useHostParts,
  useMachineParts,
} from "./NetworkRows";
import type { SavedMachineNetwork } from "./SavedEnvironmentRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

const MACHINES_HELP =
  "Ada machines on your Tailscale account show up here. Allow a new one once and every machine and app in your network can use it.";

/**
 * One list of machines: every network member this app can reach, joined by environment id with
 * the saved environments, then machines outside the network. "Phones and browsers" follow.
 */
export function MachinesSettings({
  savedEnvironments,
  renderSaved,
  headerAction,
  empty,
}: {
  /** Saved environments other than this machine's own. */
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly renderSaved: (
    environment: EnvironmentPresentation,
    network: SavedMachineNetwork | null,
  ) => ReactNode;
  readonly headerAction: ReactNode;
  readonly empty: ReactNode;
}) {
  const hosts = useNetworkHosts();
  const { states, network } = useDeviceNetworkView(hosts);
  const saved = new Map(
    savedEnvironments.map((environment) => [environment.environmentId, environment]),
  );
  const stateById = new Map(states.map((state) => [state.environmentId, state] as const));
  const presentationById = new Map(hosts.map((host) => [host.environmentId, host] as const));
  const hostOf = (environmentId: EnvironmentId) => {
    const state = stateById.get(environmentId);
    const presentation = presentationById.get(environmentId);
    return state === undefined
      ? undefined
      : { state, managedBy: presentation === undefined ? null : managedBy(presentation) };
  };
  // Agent links start from the host this app works through when it takes part.
  const linkHost = network.hosts.find((host) => host.enabled)?.environmentId ?? null;
  const shown = new Set<EnvironmentId>();
  const machineRows = network.machines.map((machine) => {
    const environmentId = machine.entry.environmentId;
    shown.add(environmentId);
    const environment = saved.get(environmentId);
    const host = hostOf(environmentId);
    return environment === undefined ? (
      <DeviceMachineRow
        key={machine.key}
        network={network}
        machine={machine}
        {...(host === undefined ? {} : { host })}
      />
    ) : (
      <SavedMachineRow
        key={machine.key}
        network={network}
        machine={machine}
        host={host ?? null}
        environment={environment}
        renderSaved={renderSaved}
      />
    );
  });
  const outside = savedEnvironments.filter((environment) => !shown.has(environment.environmentId));
  const searchableSetting = useSearchableSetting();
  const search = searchableSetting("machines");
  return (
    <>
      <SettingsSection
        id={search.id}
        title={search.title}
        headerAction={
          <div className="flex items-center gap-1">
            {headerAction}
            {linkHost === null ? null : <LinkHeaderAction environmentId={linkHost} />}
          </div>
        }
      >
        <SettingsRow title="Your machines" description={MACHINES_HELP} />
        {machineRows}
        {outside.map((environment) => renderSaved(environment, null))}
        {machineRows.length + outside.length === 0 ? empty : null}
      </SettingsSection>
      {network.apps.length === 0 ? null : (
        <SettingsSection title="Phones and browsers">
          {network.apps.map((app) => (
            <NetworkAppRow key={app.appId} network={network} app={app} />
          ))}
        </SettingsSection>
      )}
    </>
  );
}

function SavedMachineRow({
  network,
  machine,
  host,
  environment,
  renderSaved,
}: {
  readonly network: DeviceNetwork;
  readonly machine: DeviceNetworkMachine;
  readonly host: {
    readonly state: DeviceNetworkHostState;
    readonly managedBy: string | null;
  } | null;
  readonly environment: EnvironmentPresentation;
  readonly renderSaved: (
    environment: EnvironmentPresentation,
    network: SavedMachineNetwork | null,
  ) => ReactNode;
}) {
  const parts = useMachineParts({ network, machine });
  const hostParts = useHostParts(host);
  const held = useAtomValue(networkMembers.statusAtom).get(machine.entry.environmentId);
  return renderSaved(environment, {
    member: parts.member,
    activity: networkMemberActivityLabel(held, isElectron ? "app" : "browser"),
    details: [...hostParts.details, ...parts.details],
    actions: parts.actions,
    menuItems: (
      <>
        {hostParts.menuItems}
        {parts.menuItems}
      </>
    ),
    dialogs: parts.dialogs,
  });
}

const managedBy = (environment: EnvironmentPresentation) => {
  const policy = environment.serverConfig?.managedPolicy;
  return policy !== undefined && isManagedSettingPath(policy, "linkedEnvironmentsEnabled")
    ? policy.organization
    : null;
};

function LinkHeaderAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  return canLink ? <LinkEnvironmentAction environmentId={environmentId} /> : null;
}

function LinkEnvironmentAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const machines = useLinkableMachines(environmentId, open);
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [busy, setBusy] = useState(false);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const formId = useId();
  const link = useAtomCommand(peerLinkEnvironment.link, { label: "link environment" });
  const selected = choice ?? (machines.length === 0 ? ANOTHER_ADDRESS : null);
  const machine = machines.find((candidate) => candidate.environmentId === selected) ?? null;
  const targetId = machine?.environmentId ?? null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  // A picked machine that left the list has no address here either.
  const needsAddress = selected !== null && (machine === null || machine.urls.length === 0);
  // This client mints a code there when it is connected with a session that may
  // create pairing links, and only for its own addresses: anything can answer
  // as that machine at one typed in, so that one gets a code the user fetched.
  const canMint =
    targetId !== null &&
    !needsAddress &&
    Option.isSome(connected) &&
    mayMint &&
    !mintFailed.has(targetId);
  const ready =
    selected !== null &&
    (!needsAddress || address.trim().length > 0) &&
    (canMint || pairingCode.trim().length > 0);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setChoice(null);
      setAddress("");
      setPairingCode("");
      setAccess("approval-required");
      setMintFailed(new Set());
    }
  };
  // Settles to the code to link with, or null after reporting why there is none.
  const resolvePairingCode = async () => {
    if (!canMint || targetId === null) return pairingCode.trim();
    const minted = await mintPairingCodeOn(targetId, access);
    if (Result.isSuccess(minted)) return minted.success;
    setMintFailed((failed) => new Set(failed).add(targetId));
    failureToast("Could not link the environment", linkRequestFailureMessage(minted.failure));
    return null;
  };
  const submit = async () => {
    const [url, ...alternateUrls] =
      machine === null || needsAddress ? [address.trim()] : machine.urls;
    if (inFlight.current || !ready || url === undefined) return;
    inFlight.current = true;
    setBusy(true);
    const code = await resolvePairingCode();
    const result =
      code === null
        ? null
        : await link({
            environmentId,
            input: {
              url,
              ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
              // A typed address links alone: only this app's own addresses name a machine.
              ...(machine === null || needsAddress
                ? {}
                : { expectedEnvironmentId: machine.environmentId, expectedLabel: machine.label }),
              pairingCode: code,
              access,
            },
          });
    inFlight.current = false;
    setBusy(false);
    if (result === null) return;
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Linked ${result.value.label}` });
      handleOpenChange(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast("Could not link the environment", String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" variant="ghost-muted" aria-label="More machine actions" />}
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => handleOpenChange(true)}>Link for agents…</MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && busy) return;
          handleOpenChange(next);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Link an environment</DialogTitle>
            <DialogDescription>
              Agents here can then launch, message and wait on threads there. It appears in that
              environment's Connections, where it can be revoked.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              id={formId}
              className="space-y-4"
              autoComplete="off"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {machines.length > 0 ? (
                <LinkMachineSelect
                  machines={machines}
                  value={selected}
                  disabled={busy}
                  onChange={setChoice}
                />
              ) : null}
              {machine?.linked ? (
                <p className="text-xs text-muted-foreground">
                  Already linked. Linking again renews it with the access you pick.
                </p>
              ) : null}
              {needsAddress ? (
                <label className="block space-y-1.5">
                  <span className="block text-xs font-medium text-foreground">Address</span>
                  <Input
                    value={address}
                    onChange={(event) => {
                      setAddress(event.target.value);
                      // Machines found after typing began must not hide the address being typed.
                      if (choice === null) setChoice(ANOTHER_ADDRESS);
                    }}
                    placeholder="https://box.example.ts.net"
                    disabled={busy}
                    autoFocus={machines.length === 0}
                    nativeInput
                    spellCheck={false}
                  />
                  {machine !== null ? (
                    <span className="block text-xs text-muted-foreground">
                      This app has no address for {machine.label} that another machine can reach.
                      Enter its https or Tailscale address.
                    </span>
                  ) : null}
                </label>
              ) : null}
              {needsAddress && address.trim() ? <LinkAddressWarning address={address} /> : null}
              {selected === null || canMint ? null : (
                <label className="block space-y-1.5">
                  <span className="block text-xs font-medium text-foreground">Pairing code</span>
                  <Input
                    value={pairingCode}
                    onChange={(event) => setPairingCode(event.target.value)}
                    placeholder={
                      machine === null
                        ? "From that environment's Connections, or ada pair there"
                        : "Paste the code"
                    }
                    disabled={busy}
                    autoComplete="one-time-code"
                    nativeInput
                    spellCheck={false}
                  />
                  {machine !== null ? (
                    <span className="block text-xs text-muted-foreground">
                      Create a link on {machine.label}: Settings → Connections → Create link, then
                      paste its code here.
                    </span>
                  ) : null}
                </label>
              )}
              <LinkAccessPicker value={access} onChange={setAccess} disabled={busy} />
            </form>
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
              Cancel
            </DialogClose>
            <Button form={formId} type="submit" disabled={busy || !ready}>
              {busy ? "Linking…" : "Link"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
