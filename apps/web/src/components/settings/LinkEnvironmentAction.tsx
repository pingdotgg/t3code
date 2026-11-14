import { ANOTHER_ADDRESS, linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines } from "~/state/peerLinks";
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

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

export function LinkEnvironmentAction({
  environmentId,
  sourceLabel,
  onOpen,
  targetId: initialTargetId,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceLabel: string;
  readonly onOpen: () => void;
  readonly targetId?: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const machines = useLinkableMachines(environmentId, open);
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(initialTargetId ?? null);
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
    if (next) onOpen();
    setOpen(next);
    if (!next) {
      setChoice(initialTargetId ?? null);
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
            Let agents on {sourceLabel} work on a destination. Enable Linked environments in Labs on
            both devices first. Return links are set up separately.
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
            {canMint ? (
              <p className="text-xs text-muted-foreground">
                This app can pair automatically. No code is needed.
              </p>
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
                    machine === null ? "From Sharing & access there, or t3 pair" : "Paste the code"
                  }
                  disabled={busy}
                  autoComplete="one-time-code"
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    Create a link on {machine.label}: Settings → Sharing & access → Authorized
                    clients → Create link, then paste its code here.
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
