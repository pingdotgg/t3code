import { type OrchestrationV2LimitRecovery, type RunId } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  recovery: OrchestrationV2LimitRecovery | null;
  explanation: string | null;
  onChange: (recovery: OrchestrationV2LimitRecovery) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt, recovery, explanation } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: resetAt
      ? `Resets ${new Date(resetAt).toLocaleString()}`
      : "Reset time unavailable; retry manually",
    children: (
      <div className="space-y-1 text-xs text-muted-foreground">
        {explanation ? <p>{explanation}</p> : null}
        {scheduled ? <p>Auto-resume is scheduled for the reset.</p> : null}
      </div>
    ),
    actions: canSchedule ? <RecoveryActions key={runId} {...props} /> : null,
  };
}

function RecoveryActions({ runId, resetAt, recovery, onChange }: RecoveryProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  async function toggle() {
    if (resetAt === null) return;
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
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle()}>
        {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
