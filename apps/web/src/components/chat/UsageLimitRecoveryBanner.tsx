import { type OrchestrationV2LimitRecovery, type RunId } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  nowMs: number;
  recovery: OrchestrationV2LimitRecovery | null;
  onChange: (recovery: OrchestrationV2LimitRecovery) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: resetAt
      ? `Resets ${new Date(resetAt).toLocaleString()}`
      : "Reset time unavailable; retry manually",
    actions: canSchedule ? <RecoveryActions key={runId} {...props} /> : null,
  };
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, nowMs, onChange }: RecoveryProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const snoozed = recovery?.snooze === true && recovery.runId === runId && recovery.resetAt === resetAt && resetAt !== null && snoozedUntil !== null && Date.parse(snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    setPending(true);
    setError(null);
    try {
      await onChange({ runId, resetAt,
        autoResume: action === "resume" ? !scheduled : Boolean(scheduled),
        snooze: action === "snooze" ? !snoozed : snoozed,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
      </Button>
      <Button size="xs" variant="ghost" disabled={pending || (!snoozed && Date.parse(resetAt!) <= nowMs)} onClick={() => void toggle("snooze")}>
        {pending ? "Saving..." : snoozed ? "Wake now" : "Snooze until reset"}
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
