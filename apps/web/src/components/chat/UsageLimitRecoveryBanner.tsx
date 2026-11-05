import { useT } from "../../hooks/useI18n";
import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { Button } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { copyAdminRequest } from "./ThreadErrorBanner";
import { translateNow } from "../media/translateNow";

type RecoveryProps = {
  runId: RunId;
  errorCode: string | null;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, errorCode, resetAt, stoppedAt, timestampFormat } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const recoveryActions = canSchedule ? (
    <RecoveryActions key={`${runId}:${resetAt}`} {...props} />
  ) : null;
  const resetDescription = resetAt
    ? translateNow("chat.recovery.resets", {
        time: formatUpcomingTimestamp(resetAt, timestampFormat),
      })
    : translateNow("chat.recovery.resetUnavailable");
  if (!chatGptLimit) {
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      icon: <GaugeIcon />,
      title: translateNow("chat.recovery.usageLimitReached"),
      description: resetDescription,
      actions: recoveryActions,
    };
  }
  // OpenAI's partner guidelines specify this ChatGPT notice and its actions.
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    icon: <OpenAI aria-hidden="true" />,
    title: translateNow("chat.recovery.chatgptLimitReached"),
    description: workspaceLimit
      ? translateNow("chat.recovery.workspaceLimitShort")
      : resetDescription,
    actions: (
      <>
        {recoveryActions}
        {workspaceLimit ? (
          <Button size="xs" variant="ghost" onClick={copyAdminRequest}>
            {translateNow("chat.recovery.copyAdminRequest")}
          </Button>
        ) : (
          <ChatGptUsageButton size="xs" variant="ghost" />
        )}
      </>
    ),
  };
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const t = useT();
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
        title: t("chat.recovery.couldNotSnooze"),
        description: t("chat.recovery.resetPassed"),
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
            ? t("chat.recovery.couldNotChangeAutoResume")
            : t("chat.recovery.couldNotSnooze"),
        description: cause instanceof Error ? cause.message : t("chat.feedback.errorOccurred"),
      });
    }
    setPending(false);
  }
  // Inline errors would widen the actions column and crush the title.
  return (
    <>
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
        {pending
          ? t("chat.recovery.saving")
          : scheduled
            ? t("chat.recovery.cancelAutoResume")
            : t("chat.recovery.resumeAtReset")}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={pending || (!snoozed && resetPassed)}
        onClick={() => void toggle("snooze")}
      >
        {pending
          ? t("chat.recovery.saving")
          : snoozed
            ? t("chat.recovery.wakeNow")
            : t("chat.recovery.snoozeUntilReset")}
      </Button>
    </>
  );
}
