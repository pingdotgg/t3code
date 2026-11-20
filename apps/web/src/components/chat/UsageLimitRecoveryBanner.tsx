import { T, msg, useGT } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m, type MessageResolver } from "~/i18n/messages";
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
  resetPassed?: boolean;
  displayPassed?: boolean;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
};

function parseEpochMs(isoDate: string | null): number | null {
  if (isoDate === null) return null;
  const parsed = Date.parse(isoDate);
  return Number.isFinite(parsed) ? parsed : null;
}

function limitRecoveryScheduleState(
  props: Pick<
    RecoveryProps,
    "runId" | "resetAt" | "stoppedAt" | "settled" | "requestPending" | "recovery" | "snoozedUntil"
  >,
) {
  // The server refuses recovery changes while a request is pending.
  const canSchedule =
    !props.settled &&
    !props.requestPending &&
    props.resetAt !== null &&
    Date.parse(props.resetAt) > Date.parse(props.stoppedAt);
  const resumes =
    canSchedule &&
    props.recovery?.runId === props.runId &&
    props.recovery.resetAt === props.resetAt &&
    props.recovery.autoResume;
  const displayAt =
    resumes &&
    props.resetAt &&
    props.snoozedUntil &&
    Date.parse(props.snoozedUntil) > Date.parse(props.resetAt)
      ? props.snoozedUntil
      : props.resetAt;
  return { canSchedule, resumes, displayAt };
}

export function useUsageLimitRecoveryBannerItem(
  props: RecoveryProps | null,
  resolve: MessageResolver = m,
): ComposerBannerStackItem | null {
  const displayAt = props === null ? null : limitRecoveryScheduleState(props).displayAt;
  const resetPassed = useDeadlinePassed(props === null ? null : parseEpochMs(props.resetAt));
  const displayPassed = useDeadlinePassed(parseEpochMs(displayAt));
  if (props === null) return null;
  return usageLimitRecoveryBannerItem({ ...props, resetPassed, displayPassed }, resolve);
}

export function usageLimitRecoveryBannerItem(
  props: RecoveryProps,
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const { runId, errorCode, resetAt, timestampFormat } = props;
  const { canSchedule, resumes, displayAt } = limitRecoveryScheduleState(props);
  const resetAtMs = parseEpochMs(resetAt);
  const displayAtMs = parseEpochMs(displayAt);
  const resetPassed = props.resetPassed ?? (resetAtMs !== null && resetAtMs <= Date.now());
  const displayPassed = props.displayPassed ?? (displayAtMs !== null && displayAtMs <= Date.now());
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const recoveryActions = canSchedule ? (
    <RecoveryActions key={`${runId}:${resetAt}`} {...props} />
  ) : null;
  const resumesUpcoming = resumes && !displayPassed;
  const shownAt = resumesUpcoming ? displayAt : resetAt;
  const formattedTime = shownAt
    ? formatUpcomingTimestamp(shownAt, timestampFormat, undefined, undefined, resolve)
    : null;
  const resetDescription =
    formattedTime !== null
      ? resumesUpcoming
        ? resolve(msg("Resumes {time}", { time: formattedTime }))
        : resetPassed
          ? resolve(msg("Reset {time}", { time: formattedTime }))
          : resolve(msg("Resets {time}", { time: formattedTime }))
      : resolve(msg("Reset time unavailable; retry manually"));
  if (!chatGptLimit) {
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      group: "environment",
      icon: <GaugeIcon />,
      title: resolve(msg("Usage limit reached")),
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
    title: resolve(msg("ChatGPT usage limit reached")),
    description: workspaceLimit
      ? resolve(
          msg("You've reached your workspace's limit for using your ChatGPT plan in other apps."),
        )
      : resetDescription,
    actions: (
      <>
        {recoveryActions}
        {workspaceLimit ? (
          <Button size="xs" variant="ghost" onClick={copyAdminRequest}>
            <T>Copy request for admin</T>
          </Button>
        ) : (
          <ChatGptUsageButton size="xs" variant="ghost" />
        )}
      </>
    ),
  };
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const gt = useGT();
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
        title: m(msg("Could not snooze thread")),
        description: m(msg("The reset time has passed. Retry the thread manually.")),
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
        title:
          action === "resume"
            ? m(msg("Could not change auto-resume"))
            : m(msg("Could not snooze thread")),
        description: thrownErrorMessage(cause, m) ?? m(msg("An error occurred.")),
      });
    }
    setPending(false);
  }
  // Inline errors would widen the actions column and crush the title.
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <InlineButton touchTarget="padded" disabled={pending} onClick={() => void toggle("resume")}>
        {pending
          ? gt("Saving...")
          : scheduled
            ? gt("Cancel auto-resume")
            : resetPassed
              ? gt("Resume now")
              : gt("Resume at reset")}
      </InlineButton>
      <InlineButton
        touchTarget="padded"
        disabled={pending || (!snoozed && resetPassed)}
        onClick={() => void toggle("snooze")}
      >
        {pending ? gt("Saving...") : snoozed ? gt("Wake now") : gt("Snooze until reset")}
      </InlineButton>
    </span>
  );
}
