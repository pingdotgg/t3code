import {
  type OrchestrationV2CodexResetRedemption,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
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
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt, timestampFormat } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const redemption =
    props.recovery?.runId === runId && props.recovery.resetAt === resetAt
      ? props.recovery.codexResetRedemption
      : undefined;
  const redemptionReport = redemption ? codexResetRedemptionMessage(redemption) : null;
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: [
      resetAt
        ? `Resets ${formatUpcomingTimestamp(resetAt, timestampFormat)}`
        : "Reset time unavailable; retry manually",
      redemptionReport,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
    actions: canSchedule ? <RecoveryActions key={`${runId}:${resetAt}`} {...props} /> : null,
  };
}

function codexResetRedemptionMessage(redemption: OrchestrationV2CodexResetRedemption) {
  const account = redemption.accountLabel ?? "this Codex account";
  if (redemption.outcome === "reset" && redemption.allowanceCleared)
    return `Codex reported a reset for ${account}, and a fresh check found this usage limit clear.`;
  switch (redemption.outcome) {
    case "pending":
      return `Checking whether Codex applied a reset for ${account}.`;
    case "noCredit":
      return `No reset credits were available for ${account}; this thread remains limited.`;
    case "nothingToReset":
      return `No reset was used for ${account}; this thread remains limited.`;
    case "reset":
      return `Codex reported a reset for ${account}, but this usage limit is still active.`;
    case "unconfirmed":
      return `Could not confirm a reset for ${account}; this thread remains limited.`;
    case "declined":
      return `Auto-reset skipped for ${account}; this thread remains limited.`;
  }
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const [pending, setPending] = useState(false);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
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
    <>
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={pending || (!snoozed && resetPassed)}
        onClick={() => void toggle("snooze")}
      >
        {pending ? "Saving..." : snoozed ? "Wake now" : "Snooze until reset"}
      </Button>
    </>
  );
}
