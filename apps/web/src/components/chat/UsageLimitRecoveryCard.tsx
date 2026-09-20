import * as DateTime from "effect/DateTime";
import { type OrchestrationV2LimitRecovery, type RunId } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";

export function UsageLimitRecoveryCard({
  runId,
  resetAt,
  stoppedAt,
  recovery,
  onChange,
}: {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  recovery: OrchestrationV2LimitRecovery | null;
  onChange: (recovery: OrchestrationV2LimitRecovery) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  async function toggle() {
    if (resetAt === null || !canSchedule) return;
    setPending(true);
    setError(null);
    try {
      await onChange({ runId, resetAt, autoResume: !scheduled });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="pointer-events-auto mb-2 w-full rounded-lg border border-amber-500/25 bg-background/95 px-3 py-2 text-sm">
      <p>
        {resetAt
          ? `Usage limit resets ${DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleString()}.`
          : "The provider did not report a reset time. Retry manually when your limit is available."}
      </p>
      {canSchedule ? (
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void toggle()}
        >
          {scheduled ? "Cancel auto-resume" : "Resume at reset"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
