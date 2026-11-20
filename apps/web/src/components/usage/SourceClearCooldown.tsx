import { useGT, T } from "gt-react";
import type { EnvironmentId, UsageLimitSourceClearCooldownInput } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function SourceClearCooldown({
  environmentId,
  input,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: UsageLimitSourceClearCooldownInput;
  readonly label?: string | undefined;
}) {
  const gt = useGT();
  const clearCooldown = useAtomCommand(serverEnvironment.clearSourceCooldown, {
    reportFailure: false,
  });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const clear = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus(null);
    const result = await clearCooldown({ environmentId, input }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
    setStatus(
      result._tag === "Success"
        ? gt("Proxy cooldown cleared. Retry your request.")
        : "error" in result.cause && result.cause.error instanceof Error
          ? result.cause.error.message
          : gt("Could not clear the proxy cooldown."),
    );
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void clear()}>
        {busy ? gt("Clearing…") : gt("Clear cooldown")}
      </Button>
      <p className="text-xs text-muted-foreground">
        <T>Clear a stale proxy block after resetting quota. No reset credit is used.</T>
      </p>
      {status ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
    </div>
  );
}
