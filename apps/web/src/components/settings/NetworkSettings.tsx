import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ANOTHER_ADDRESS, linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  type DeviceNetworkHostState,
  refreshDeviceNetwork,
} from "@t3tools/client-runtime/state/deviceNetwork";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DeviceNetworkGroup } from "@t3tools/client-runtime/tailnet-devices";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  isManagedSettingPath,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { useContext, useId, useRef, useState } from "react";

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
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { LinkAccessPicker } from "./LinkAccessPicker";
import { LinkAddressWarning, LinkMachineSelect } from "./LinkMachineSelect";
import {
  DeviceMachineRow,
  NetworkAppRow,
  TakingPartRow,
  useDeviceNetworkView,
} from "./NetworkRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

/**
 * The one Device network view: every connected host's roster merged, grouped by network, with
 * each machine's own switch in "Taking part". Hidden while no connected host offers it.
 */
export function DeviceNetworkSettings() {
  const hosts = useNetworkHosts();
  if (hosts.length === 0) return null;
  return <DeviceNetworkSection hosts={hosts} />;
}

const managedBy = (environment: EnvironmentPresentation) => {
  const policy = environment.serverConfig?.managedPolicy;
  return policy !== undefined && isManagedSettingPath(policy, "linkedEnvironmentsEnabled")
    ? policy.organization
    : null;
};

function DeviceNetworkSection({
  hosts,
}: {
  readonly hosts: ReadonlyArray<EnvironmentPresentation>;
}) {
  const { states, groups } = useDeviceNetworkView(hosts);
  const registry = useContext(RegistryContext);
  const stateById = new Map(states.map((state) => [state.environmentId, state] as const));
  const presentationById = new Map(hosts.map((host) => [host.environmentId, host] as const));
  const onChanged = () => refreshDeviceNetwork(registry, peerLinkEnvironment.list, states);
  // Pairing-code links start from the host this app works through when it takes part.
  const linkHost =
    groups.flatMap((group) => group.hosts).find((host) => host.enabled)?.environmentId ?? null;
  const search = searchableSetting("device-network");
  return (
    <SettingsSection
      id={search.id}
      title={search.title}
      headerAction={linkHost === null ? null : <LinkHeaderAction environmentId={linkHost} />}
    >
      {groups.map((group) => (
        <NetworkGroupRows
          key={group.key}
          group={group}
          showHeading={groups.length > 1}
          hostStates={group.hosts.flatMap((host) => stateById.get(host.environmentId) ?? [])}
          managedBy={(environmentId) => {
            const presentation = presentationById.get(environmentId);
            return presentation === undefined ? null : managedBy(presentation);
          }}
          onChanged={onChanged}
        />
      ))}
    </SettingsSection>
  );
}

function groupDescription(group: DeviceNetworkGroup): string {
  if (!group.inNetwork && !group.addsToNetwork) {
    return "Not in your network. To add it, choose Allow joining here, then add it from a full-access machine in your network.";
  }
  if (!group.inNetwork) {
    return group.machines.some((machine) => machine.kind === "found")
      ? "Not in a network yet. Machines join only when you add them; adding one starts your network with this machine at full access."
      : "Not in a network yet. Your other machines on Tailscale show up here once they run T3 Code. Being on the same Tailscale account is not permission: you add each one.";
  }
  return group.authority === null
    ? "Only a full-access machine can change the network, and none this app may change it through is connected."
    : "Changes go to every machine in the network.";
}

function NetworkGroupRows({
  group,
  showHeading,
  hostStates,
  managedBy: managedByHost,
  onChanged,
}: {
  readonly group: DeviceNetworkGroup;
  readonly showHeading: boolean;
  readonly hostStates: ReadonlyArray<DeviceNetworkHostState>;
  readonly managedBy: (environmentId: EnvironmentId) => string | null;
  readonly onChanged: () => void;
}) {
  const takingPart = hostStates.some((host) => host.enabled);
  const unavailable = hostStates.every((host) => host.list === "unavailable");
  return (
    <>
      <SettingsRow
        title={
          showHeading
            ? group.inNetwork
              ? "Your network"
              : `${group.hosts[0]?.label ?? "This machine"}: not in a network`
            : "Taking part"
        }
        description={`${showHeading ? "" : "Each machine has its own switch. While it is off, its agents start nothing over a link; running tasks finish. "}${groupDescription(group)}`}
      />
      {hostStates.map((host) => (
        <TakingPartRow
          key={host.environmentId}
          host={host}
          managedBy={managedByHost(host.environmentId)}
          onChanged={onChanged}
        />
      ))}
      {!takingPart || unavailable ? null : (
        <>
          {group.machines.map((machine) => (
            <DeviceMachineRow
              key={machine.key}
              group={group}
              machine={machine}
              onChanged={onChanged}
            />
          ))}
          {group.apps.map((app) => (
            <NetworkAppRow key={app.appId} group={group} app={app} onChanged={onChanged} />
          ))}
          {group.machines.length + group.apps.length === 0 &&
          hostStates.some((host) => host.list === "ready") ? (
            <SettingsRow
              title="No other machines yet"
              description="Machines on your Tailscale account that run T3 Code appear here to add. Link any other machine, such as a VPS, with a pairing code."
            />
          ) : null}
        </>
      )}
    </>
  );
}

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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            Link
          </Button>
        }
      />
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
                      ? "From that environment's Connections, or t3 pair there"
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
  );
}
