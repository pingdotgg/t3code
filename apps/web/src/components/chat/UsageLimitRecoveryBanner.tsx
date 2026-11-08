import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import { limitRecoveryOwnsSnooze } from "@t3tools/client-runtime/state/thread-execution";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { Button, InlineButton } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { copyAdminRequest } from "./ThreadErrorBanner";

type RecoveryProps = {
  runId: RunId;
  errorCode: string | null;
  resetAt: string | null;
  stoppedAt: string;
  settled: boolean;
  requestPending: boolean;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  /** Other accounts the stopped run can continue on now. */
  continueOn?: ReadonlyArray<ContinueOnTarget>;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
};

type ContinueOnTarget = {
  readonly instanceId: string;
  readonly label: string;
  readonly onSelect: () => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const {
    runId,
    errorCode,
    resetAt,
    stoppedAt,
    settled,
    requestPending,
    recovery,
    snoozedUntil,
    timestampFormat,
  } = props;
  // The server refuses recovery changes while a request is pending.
  const canSchedule =
    !settled && !requestPending && resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const resumes =
    canSchedule && recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const continueOn = !settled && !requestPending ? (props.continueOn ?? []) : [];
  const recoveryActions =
    canSchedule || continueOn.length > 0 ? (
      <>
        {continueOn.length > 0 ? <ContinueOnActions key={runId} targets={continueOn} /> : null}
        {canSchedule ? <RecoveryActions key={`${runId}:${resetAt}`} {...props} /> : null}
      </>
    ) : null;
  const displayAt =
    resumes && resetAt && snoozedUntil && Date.parse(snoozedUntil) > Date.parse(resetAt)
      ? snoozedUntil
      : resetAt;
  const resetDescription = displayAt
    ? `${resumes ? "Resumes" : "Resets"} ${formatUpcomingTimestamp(displayAt, timestampFormat)}`
    : "Reset time unavailable; retry manually";
  if (!chatGptLimit) {
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      group: "environment",
      icon: <GaugeIcon />,
      title: "Usage limit reached",
      description: resetDescription,
      actions: recoveryActions,
    };
  }
  // OpenAI's partner guidelines specify this ChatGPT notice and its actions.
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    group: "environment",
    icon: <OpenAI aria-hidden="true" />,
    title: "ChatGPT usage limit reached",
    description: workspaceLimit
      ? "You've reached your workspace's limit for using your ChatGPT plan in other apps."
      : resetDescription,
    actions: (
      <>
        {recoveryActions}
        {workspaceLimit ? (
          <Button size="xs" variant="ghost" onClick={copyAdminRequest}>
            Copy request for admin
          </Button>
        ) : (
          <ChatGptUsageButton size="xs" variant="ghost" />
        )}
      </>
    ),
  };
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const [pending, setPending] = useState(false);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  // The server leaves snoozedUntil in place after the timer wakes the thread,
  // so a snooze whose reset has passed is no longer active.
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const snoozed =
    limitRecoveryOwnsSnooze({ runId, resetAt, recovery, snoozedUntil }) && !resetPassed;
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
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <InlineButton touchTarget="padded" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
      </InlineButton>
      <InlineButton
        touchTarget="padded"
        disabled={pending || (!snoozed && resetPassed)}
        onClick={() => void toggle("snooze")}
      >
        {pending ? "Saving..." : snoozed ? "Wake now" : "Snooze until reset"}
      </InlineButton>
    </span>
  );
}

function ContinueOnActions({ targets }: { targets: ReadonlyArray<ContinueOnTarget> }) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  async function select(target: ContinueOnTarget) {
    setPendingId(target.instanceId);
    try {
      await target.onSelect();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Could not continue on ${target.label}`,
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPendingId(null);
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      {targets.map((target) => (
        <InlineButton
          key={target.instanceId}
          touchTarget="padded"
          disabled={pendingId !== null}
          onClick={() => void select(target)}
        >
          {pendingId === target.instanceId ? "Continuing..." : `Continue on ${target.label}`}
        </InlineButton>
      ))}
    </span>
  );
}
