import { useAtomValue } from "@effect/atom-react";
import { linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { useRef, useState } from "react";

import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines } from "~/state/peerLinks";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LinkAccessPicker } from "./LinkAccessPicker";

export function LinkedEnvironmentEditor({
  environmentId,
  link,
  onForget,
  canForget,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
  readonly onForget: () => void;
  readonly canForget: boolean;
  readonly disabled: boolean;
}) {
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const machines = useLinkableMachines(environmentId, true);
  const machine = machines.find((candidate) => candidate.environmentId === link.environmentId);
  const prepared = usePreparedConnection(link.environmentId);
  const mayMint = useEnvironmentScope(link.environmentId, AuthAccessWriteScope);
  const renew = useAtomCommand(peerLinkEnvironment.link, { label: "renew environment link" });
  const [access, setAccess] = useState<AuthMcpClientAccess>(link.access);
  const [pairingCode, setPairingCode] = useState("");
  const [mintFailed, setMintFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  const canMint =
    Option.isSome(prepared) && mayMint && (machine?.urls.length ?? 0) > 0 && !mintFailed;
  const urls = [...new Set([...(canMint ? machine!.urls : []), ...link.urls])];
  const dirty = access !== link.access;
  const submit = async () => {
    if (
      inFlight.current ||
      disabled ||
      !canLink ||
      (!canMint && !pairingCode.trim()) ||
      urls.length === 0
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSaved(false);
    let code = pairingCode.trim();
    if (canMint) {
      const minted = await mintPairingCodeOn(link.environmentId, access);
      if (Result.isFailure(minted)) {
        setMintFailed(true);
        setError(linkRequestFailureMessage(minted.failure));
        setBusy(false);
        inFlight.current = false;
        return;
      }
      code = minted.success;
    }
    const result = await renew({
      environmentId,
      input: {
        url: urls[0]!,
        alternateUrls: urls.slice(1),
        expectedEnvironmentId: link.environmentId,
        expectedLabel: link.label,
        access,
        pairingCode: code,
      },
    });
    setBusy(false);
    inFlight.current = false;
    setPairingCode("");
    if (result._tag === "Success") setSaved(true);
    else if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="grid gap-4 sm:grid-cols-2 sm:gap-6"
    >
      <div className="min-w-0">
        <LinkAccessPicker
          value={access}
          onChange={(next) => {
            setAccess(next);
            setSaved(false);
          }}
          disabled={busy || disabled || !canLink}
          compact
        />
        {canLink && !canMint ? (
          <label className="mt-3 block space-y-1.5">
            <span className="text-xs font-medium">Pairing code</span>
            <Input
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value)}
              disabled={busy || disabled}
              autoComplete="one-time-code"
              nativeInput
              spellCheck={false}
              placeholder="Paste a code from the destination"
            />
            <span className="block text-xs text-muted-foreground">
              Create a link in {link.label}’s Sharing & access, or run <code>t3 pair</code> there.
            </span>
          </label>
        ) : null}
      </div>
      <div className="min-w-0 space-y-2">
        <p className="text-xs">
          <span className="text-muted-foreground">Expires </span>
          {DateTime.formatLocal(link.expiresAt, { dateStyle: "medium" })}
        </p>
        <Tooltip>
          <TooltipTrigger render={<p />} className="truncate text-xs text-muted-foreground">
            {link.urls.join(", ")}
          </TooltipTrigger>
          <TooltipPopup>{link.urls.join(", ")}</TooltipPopup>
        </Tooltip>
        <div className="flex flex-wrap gap-2">
          {canLink ? (
            <Button
              type="submit"
              size="xs"
              disabled={busy || disabled || (!canMint && !pairingCode.trim()) || urls.length === 0}
            >
              {busy ? "Renewing…" : dirty ? "Save & renew" : "Renew"}
            </Button>
          ) : null}
          {dirty && canLink ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || disabled}
              onClick={() => {
                setAccess(link.access);
                setPairingCode("");
                setSaved(false);
              }}
            >
              Cancel
            </Button>
          ) : null}
          {canForget ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy || disabled}
              onClick={onForget}
            >
              Forget
            </Button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-xs text-success">
            Link renewed.
          </p>
        ) : null}
      </div>
    </form>
  );
}
