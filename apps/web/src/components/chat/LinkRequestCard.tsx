import { useAtomValue } from "@effect/atom-react";
import {
  type LinkableMachine,
  linkRequestAnswerInput,
  linkRequestDefaultAccess,
  linkRequestDisplay,
  linkRequestFailureMessage,
  linkRequestInitialMachine,
  type LinkRequestItem,
  linkRequestTargetName,
  rankMachinesByHint,
} from "@t3tools/client-runtime/link-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CheckIcon, LinkIcon, MinusIcon, XIcon } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { mintPairingCodeOn } from "../../state/peerPairingCode";
import { useLinkableMachines } from "../../state/peerLinks";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { LinkAccessPicker } from "../settings/LinkAccessPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { WorkLogRow } from "./WorkLog";

const accessLabel = (access: AuthMcpClientAccess) => accessConfig[access].label;

/** The machine list's row for linking by an address typed in. */
const ANOTHER_ADDRESS = "another-address";

/** Whether the agent left the machine for the user to pick. */
const picksMachine = (item: LinkRequestItem) =>
  item.environmentId === undefined && item.url === undefined;

/**
 * Inline card for a link an agent asked the user to make. The user picks the
 * access in a dialog; the pairing code lives only in that dialog's state and
 * the RPC payload, and is never logged, toasted, or persisted.
 */
export function LinkRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LinkRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = linkRequestDisplay(item, props.visibility, accessLabel);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LinkIcon
        : display.outcome === "linked"
          ? CheckIcon
          : display.outcome === "failed"
            ? XIcon
            : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={display.label}
      />
    );
  }
  return <PendingLinkRequest environmentId={props.environmentId} item={item} />;
}

function PendingLinkRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LinkRequestItem;
}) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = useAtomCommand(serverEnvironment.answerLinkRequest, {
    label: "decline link request",
    reportFailure: false,
    reportDefect: false,
  });
  const canAnswer = useAtomValue(
    serverEnvironment.answerLinkRequest.permissionAtom(props.environmentId),
  );
  const target = linkRequestTargetName(item);

  const decline = async () => {
    const input = linkRequestAnswerInput(item, { type: "decline" });
    if (input === null) return;
    setDeclining(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() =>
      setDeclining(false),
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(linkRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          {picksMachine(item)
            ? "Link a machine to this environment"
            : `Link ${target} to this environment`}
        </p>
        {item.reason.trim() ? <p className="text-sm text-muted-foreground">{item.reason}</p> : null}
        {item.label !== undefined && item.url !== undefined ? (
          <p className="truncate text-xs text-muted-foreground/80">{item.url}</p>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {canAnswer ? (
        <div className="flex min-w-0 items-center justify-end gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            disabled={declining}
            onClick={() => void decline()}
          >
            Decline
          </Button>
          <Button type="button" size="xs" disabled={declining} onClick={() => setOpen(true)}>
            {picksMachine(item) ? "Choose machine…" : "Review link…"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only a session that manages access here can answer this.
        </p>
      )}
      <LinkRequestDialog
        environmentId={props.environmentId}
        item={item}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

/**
 * What the dialog links: a machine from the client's catalog, or an address.
 * `urls` is empty when the client knows no direct address for the machine,
 * so the user types one.
 */
type DialogTarget =
  | { readonly kind: "none" }
  | {
      readonly kind: "machine";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly urls: ReadonlyArray<string>;
      readonly linked: boolean;
    }
  | { readonly kind: "address" };

function resolveTarget(
  item: LinkRequestItem,
  machines: ReadonlyArray<LinkableMachine>,
  choice: string | null,
): DialogTarget {
  if (item.environmentId === undefined && item.url !== undefined) return { kind: "address" };
  const chosen = item.environmentId ?? choice;
  if (chosen === null) return { kind: "none" };
  if (chosen === ANOTHER_ADDRESS) return { kind: "address" };
  const machine = machines.find((candidate) => candidate.environmentId === chosen);
  return {
    kind: "machine",
    environmentId: machine?.environmentId ?? (chosen as EnvironmentId),
    label: machine?.label ?? linkRequestTargetName(item),
    urls: [...new Set([...(machine?.urls ?? []), ...(item.url === undefined ? [] : [item.url])])],
    linked: machine?.linked ?? false,
  };
}

function LinkRequestDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LinkRequestItem;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { item } = props;
  const formId = useId();
  const pickMachine = picksMachine(item);
  const listed = useLinkableMachines(props.environmentId, props.open);
  const machines = useMemo(() => rankMachinesByHint(listed, item.hint), [listed, item.hint]);
  // Null until the user picks; until then the hint's best match is picked.
  const [choice, setChoice] = useState<string | null>(null);
  const [address, setAddress] = useState(item.url ?? "");
  const [access, setAccess] = useState<AuthMcpClientAccess>(() => linkRequestDefaultAccess(item));
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const answer = useAtomCommand(serverEnvironment.answerLinkRequest, {
    label: "answer link request",
    // The failure cause holds the request, and with it the code; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const selected = choice ?? linkRequestInitialMachine(item, machines);
  const target = resolveTarget(item, machines, selected);
  const targetName = target.kind === "machine" ? target.label : linkRequestTargetName(item);
  // This client can mint a code there when it is connected to that
  // environment with a session that may create pairing links.
  const targetId = target.kind === "machine" ? target.environmentId : null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  const canMint =
    targetId !== null && Option.isSome(connected) && mayMint && !mintFailed.has(targetId);
  const needsAddress =
    target.kind === "address" || (target.kind === "machine" && target.urls.length === 0);
  const useExisting = target.kind === "machine" && target.linked;
  const ready =
    target.kind !== "none" &&
    (useExisting ||
      ((!needsAddress || address.trim().length > 0) && (canMint || pairingCode.trim().length > 0)));

  const reset = () => {
    setChoice(null);
    setAddress(item.url ?? "");
    setAccess(linkRequestDefaultAccess(item));
    setPairingCode("");
    setError(null);
  };

  const submit = async () => {
    if (inFlight.current || target.kind === "none") return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let input;
      if (target.kind === "machine" && target.linked) {
        input = linkRequestAnswerInput(item, {
          type: "use-existing",
          environmentId: target.environmentId,
        });
      } else {
        let code = pairingCode;
        if (canMint && targetId !== null) {
          try {
            code = await mintPairingCodeOn(targetId);
          } catch (cause) {
            setMintFailed((failed) => new Set(failed).add(targetId));
            setError(linkRequestFailureMessage(cause));
            return;
          }
        }
        input = linkRequestAnswerInput(item, {
          type: "link",
          target:
            target.kind === "address"
              ? { url: address }
              : { ...target, urls: needsAddress ? [address.trim()] : target.urls },
          access,
          pairingCode: code,
        });
      }
      if (input === null) return;
      const result = await answer({ environmentId: props.environmentId, input });
      if (result._tag === "Success") {
        // The card switches to its answered row once the item updates.
        setPairingCode("");
        props.onOpenChange(false);
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        setError(linkRequestFailureMessage(squashAtomCommandFailure(result)));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        props.onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{pickMachine ? "Link a machine" : `Link ${targetName}`}</DialogTitle>
          <DialogDescription>
            Agents here can then launch, message and wait on threads there. It appears in that
            machine's Connections, where it can be revoked.
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
            {pickMachine ? (
              <MachinePicker
                machines={machines}
                value={selected}
                disabled={busy}
                onChange={(next) => {
                  setChoice(next);
                  setError(null);
                }}
              />
            ) : item.url !== undefined ? (
              <p className="truncate text-xs text-muted-foreground">{item.url}</p>
            ) : null}
            {needsAddress && !(item.url !== undefined && item.environmentId === undefined) ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Address</span>
                <Input
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="https://machine.tailnet.ts.net"
                  disabled={busy}
                  nativeInput
                  spellCheck={false}
                />
                {target.kind === "machine" ? (
                  <span className="block text-xs text-muted-foreground">
                    This app reaches {target.label} only through T3 Connect or SSH. Enter its https
                    or Tailscale address.
                  </span>
                ) : null}
              </label>
            ) : null}
            {useExisting ? (
              <p className="text-xs text-muted-foreground">
                This environment is already linked to {targetName}. The agent can use that link as
                it is; change its access in Settings → Connections.
              </p>
            ) : target.kind === "none" ? null : (
              <>
                {canMint ? null : (
                  <label className="block space-y-1.5">
                    <span className="block text-xs font-medium text-foreground">Pairing code</span>
                    <Input
                      value={pairingCode}
                      onChange={(event) => setPairingCode(event.target.value)}
                      placeholder="Paste the code"
                      disabled={busy}
                      autoComplete="one-time-code"
                      nativeInput
                      spellCheck={false}
                    />
                    <span className="block text-xs text-muted-foreground">
                      Create a link on {targetName}: Settings → Connections → Create link, then
                      paste its code here.
                    </span>
                  </label>
                )}
                <LinkAccessPicker value={access} onChange={setAccess} />
              </>
            )}
            {error !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button form={formId} type="submit" disabled={busy || !ready}>
            {busy ? "Linking…" : useExisting ? "Use this link" : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The user's other machines, best match for the agent's hint first, then an address. */
function MachinePicker(props: {
  readonly machines: ReadonlyArray<LinkableMachine>;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const labelId = useId();
  return (
    <div className="space-y-2">
      <span id={labelId} className="block text-xs font-medium">
        Machine
      </span>
      <RadioGroup
        aria-labelledby={labelId}
        value={props.value}
        disabled={props.disabled}
        onValueChange={(next) => props.onChange(next as string)}
      >
        {props.machines.map((machine) => (
          <label
            key={machine.environmentId}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm"
          >
            <Radio value={machine.environmentId} />
            <EnvironmentMachineIcon
              kind={machine.machine}
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate font-medium">{machine.label}</span>
            {machine.linked ? (
              <Badge variant="success" size="sm">
                Linked
              </Badge>
            ) : machine.connected ? null : (
              <Badge variant="outline" size="sm">
                Not connected
              </Badge>
            )}
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm">
          <Radio value={ANOTHER_ADDRESS} />
          <span className="min-w-0 flex-1 font-medium">Another address…</span>
        </label>
      </RadioGroup>
    </div>
  );
}
