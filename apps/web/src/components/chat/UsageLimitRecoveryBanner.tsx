import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import { GaugeIcon, TimerIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Button } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  onDismiss?: () => void;
};

function isAutoResumeScheduled({ runId, resetAt, recovery }: RecoveryProps): boolean {
  return Boolean(recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume);
}

function formatTimeUntil(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `in ${hours}h ${minutes % 60}m` : `in ${minutes}m`;
}

/** Counts down to the reset. It re-renders once a minute, never per frame. */
function ResetCountdown({ resetAt }: { resetAt: string }) {
  const deadline = Date.parse(resetAt);
  const passed = useDeadlinePassed(deadline);
  const remainingMs = deadline - Date.parse(`${useNowMinute()}:00.000Z`);
  return !passed && remainingMs > 0 ? formatTimeUntil(remainingMs) : "now";
}

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt, timestampFormat } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const scheduled = resetAt !== null && isAutoResumeScheduled(props);
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    icon: scheduled ? <TimerIcon /> : <GaugeIcon />,
    title:
      scheduled && resetAt
        ? `Resumes ${formatUpcomingTimestamp(resetAt, timestampFormat)}`
        : "Usage limit reached",
    description:
      scheduled && resetAt ? (
        <ResetCountdown resetAt={resetAt} />
      ) : resetAt ? (
        `Resets ${formatUpcomingTimestamp(resetAt, timestampFormat)}`
      ) : (
        "Reset time unavailable; retry manually"
      ),
    actions: canSchedule ? <RecoveryActions key={`${runId}:${resetAt}`} {...props} /> : null,
    ...(props.onDismiss
      ? { dismissLabel: "Dismiss usage limit notice", onDismiss: props.onDismiss }
      : {}),
  };
}

function RecoveryActions(props: RecoveryProps) {
  const { runId, resetAt, recovery, snoozedUntil, onChange } = props;
  const [pending, setPending] = useState(false);

  const scheduled = isAutoResumeScheduled(props);
  // The server leaves snoozedUntil in place after the timer wakes the thread,
  // so a snooze whose reset has passed is no longer active.
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt) &&
    !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: "Could not snooze thread",
        description: "The reset time has passed. Retry the thread manually.",
      });
      // The deadline timer can lag after a throttled tab or sleep; disable now.
      deadlineStore(Date.parse(resetAt)).refresh();
      return;
    }
    setPending(true);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "resume" ? "Could not change auto-resume" : "Could not snooze thread",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  // Inline errors would widen the actions column and crush the title.
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* An active snooze must stay reversible while auto-resume is scheduled. */}
      {snoozed || !scheduled ? (
        <Button
          size="xs"
          variant="secondary"
          disabled={pending || (!snoozed && resetPassed)}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "Saving..." : snoozed ? "Wake now" : "Snooze until reset"}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant={scheduled ? "secondary" : "default"}
        disabled={pending}
        onClick={() => void toggle("resume")}
      >
        {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
      </Button>
    </div>
  );
}
