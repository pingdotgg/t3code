import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { limitRecoveryOwnsSnooze } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_USAGE_URL,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import * as Clipboard from "expo-clipboard";
import { T, useGT } from "gt-react-native";
import { m } from "../../i18n/messages";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { useDeadlinePassed } from "../../lib/clock";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function UsageLimitRecoveryCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const canSchedule =
    thread.settledOverride !== "settled" &&
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
  const displayAt =
    canSchedule &&
    scheduled &&
    resetAt &&
    thread.snoozedUntil &&
    (recovery?.resetEarly || Date.parse(thread.snoozedUntil) > Date.parse(resetAt))
      ? thread.snoozedUntil
      : resetAt;
  const [copied, setCopied] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const code = thread.runtime?.lastErrorCode;
  // OpenAI's partner guidelines specify the ChatGPT notice and its action.
  const workspaceLimit = code === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || code === CHATGPT_USAGE_LIMIT_CODE;
  if (
    thread.runtime?.status !== "failed" ||
    // Older servers report ChatGPT sharing limits as provider errors.
    (thread.runtime.lastErrorClass !== "usage_limit" && !chatGptLimit) ||
    !runId
  )
    return null;
  const resetDate = displayAt
    ? new Date(displayAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const resumes = canSchedule && scheduled;
  const resetText =
    resetDate === null
      ? null
      : resumes
        ? gt("Resumes {date}.", { date: resetDate })
        : gt("Resets {date}.", { date: resetDate });
  const snoozed =
    limitRecoveryOwnsSnooze({
      runId,
      resetAt,
      recovery,
      snoozedUntil: thread.snoozedUntil,
    }) && !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (!resetAt || !runId || !canSchedule) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError(gt("The reset time has passed. Retry the thread manually."));
      return;
    }
    setPending(true);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: {
        threadId: thread.id,
        limitRecovery: {
          runId,
          resetAt,
          ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
        },
      },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(errorDisplayMessage(cause, m) ?? gt("Could not change limit recovery."));
    }
  }
  const action = workspaceLimit
    ? {
        label: gt("Copy request for admin"),
        role: "button" as const,
        run: () => {
          setError(null);
          setCopied(false);
          setActionPending(true);
          void Clipboard.setStringAsync(CHATGPT_WORKSPACE_ADMIN_REQUEST)
            .then(
              () => setCopied(true),
              () => setError(gt("Could not copy the request. Try again.")),
            )
            .finally(() => setActionPending(false));
        },
      }
    : {
        label: gt("Manage usage"),
        role: "link" as const,
        run: () => {
          setError(null);
          setActionPending(true);
          void Linking.openURL(CHATGPT_USAGE_URL)
            .catch(() =>
              setError(gt("Could not open ChatGPT. Go to chatgpt.com → Settings → Usage.")),
            )
            .finally(() => setActionPending(false));
        },
      };
  return (
    <View
      accessibilityRole={chatGptLimit ? "alert" : undefined}
      className="mx-3 mb-2 flex-row gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3"
    >
      {chatGptLimit ? (
        <View className="pt-0.5">
          <ProviderIcon provider="codex" size={16} />
        </View>
      ) : null}
      <View className="min-w-0 flex-1 gap-1">
        {chatGptLimit ? (
          <Text className="text-sm font-t3-medium text-foreground">
            <T>ChatGPT usage limit reached</T>
          </Text>
        ) : null}
        <Text
          className={
            chatGptLimit ? "text-sm text-foreground-muted" : "text-sm text-warning-foreground"
          }
        >
          {workspaceLimit
            ? copied
              ? gt("Request copied. Send it to your workspace admin.")
              : gt(
                  "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits.",
                )
            : chatGptLimit
              ? (resetText ?? gt("Review your usage settings in ChatGPT."))
              : resetDate !== null
                ? resumes
                  ? gt("Usage limit reached. Resumes {date}.", { date: resetDate })
                  : gt("Usage limit reached. Resets {date}.", { date: resetDate })
                : gt(
                    "Usage limit reached. The provider did not report a reset time. Retry manually when your limit is available.",
                  )}
        </Text>
        {chatGptLimit || canSchedule ? (
          // The margins cancel the 44pt touch height so the links sit 8pt under the text.
          <View className="-mb-3 -mt-2 flex-row flex-wrap gap-x-4">
            {chatGptLimit ? (
              <RecoveryAction
                label={action.label}
                role={action.role}
                disabled={actionPending}
                onPress={action.run}
              />
            ) : null}
            {canSchedule ? (
              <>
                <RecoveryAction
                  label={scheduled ? gt("Cancel auto-resume") : gt("Resume at reset")}
                  disabled={pending}
                  onPress={() => void toggle("resume")}
                />
                <RecoveryAction
                  label={snoozed ? gt("Wake now") : gt("Snooze until reset")}
                  disabled={pending || (!snoozed && resetPassed)}
                  onPress={() => void toggle("snooze")}
                />
              </>
            ) : null}
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function RecoveryAction(props: {
  readonly label: string;
  readonly role?: "button" | "link";
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={props.role ?? "button"}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={{ left: 8, right: 8 }}
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-70"
    >
      <Text
        className={
          props.disabled
            ? "text-sm font-t3-medium text-foreground-muted"
            : "text-sm font-t3-medium text-primary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
