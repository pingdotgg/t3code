import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { usageSharingEnvironment } from "../../state/usageSharing";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * Redeems a Continuum sharing code. Works with no AI account connected: the shared connection
 * appears in the model picker once it is added.
 */
export function RedeemShareCode({
  environmentId,
  onRedeemed,
}: {
  readonly environmentId: EnvironmentId;
  readonly onRedeemed?: (label: string) => void;
}) {
  const redeem = useAtomCommand(usageSharingEnvironment.redeem, { reportFailure: false });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly ok: boolean; readonly text: string } | null>(
    null,
  );

  const submit = async () => {
    if (code.trim() === "" || busy) return;
    setBusy(true);
    setMessage(null);
    const result = await redeem({ environmentId, input: { code: code.trim() } });
    setBusy(false);
    if (result._tag === "Success") {
      const added = result.value.connections.at(-1);
      setCode("");
      setMessage({
        ok: true,
        text: `Connected to “${added?.label ?? "shared AI"}”. Pick it in the model menu to start.`,
      });
      onRedeemed?.(added?.label ?? "shared AI");
      return;
    }
    const cause = squashAtomCommandFailure(result);
    setMessage({
      ok: false,
      text:
        cause instanceof Error && cause.message
          ? cause.message
          : "That code could not be redeemed.",
    });
  };

  return (
    <form
      className="flex w-full flex-col gap-2"
      data-redeem-share-code
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex w-full items-center gap-2">
        <Input
          aria-label="Sharing code"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste a sharing code (ctn1_…)"
          value={code}
          onChange={(event) => setCode(event.currentTarget.value)}
        />
        <Button type="submit" size="sm" disabled={busy || code.trim() === ""}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </div>
      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}
        >
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
