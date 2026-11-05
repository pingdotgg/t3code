import { Button } from "../../components/ui/Button";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_USAGE_URL,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Clipboard from "expo-clipboard";
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
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const canSchedule =
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
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
  const resetText = resetAt
    ? `Usage limit resets ${DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleString()}.`
    : null;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    thread.snoozedUntil !== null &&
    Date.parse(thread.snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (!resetAt || !runId || !canSchedule) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
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
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    }
  }
  const action = workspaceLimit
    ? {
        label: "Copy request for admin",
        role: "button" as const,
        run: () => {
          setError(null);
          setCopied(false);
          setActionPending(true);
          void Clipboard.setStringAsync(CHATGPT_WORKSPACE_ADMIN_REQUEST)
            .then(
              () => setCopied(true),
              () => setError("Could not copy the request. Try again."),
            )
            .finally(() => setActionPending(false));
        },
      }
    : {
        label: "Manage usage",
        role: "link" as const,
        run: () => {
          setError(null);
          setActionPending(true);
          void Linking.openURL(CHATGPT_USAGE_URL)
            .catch(() => setError("Could not open ChatGPT. Go to chatgpt.com → Settings → Usage."))
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
      <View className="min-w-0 flex-1 gap-2">
        {chatGptLimit ? (
          <View className="gap-1">
            <Text className="text-sm font-t3-medium text-foreground">
              ChatGPT usage limit reached
            </Text>
            <Text className="text-sm text-foreground-muted">
              {workspaceLimit
                ? copied
                  ? "Request copied. Send it to your workspace admin."
                  : "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits."
                : (resetText ?? "Review your usage settings in ChatGPT.")}
            </Text>
            <Pressable
              accessibilityRole={action.role}
              accessibilityState={{ disabled: actionPending }}
              disabled={actionPending}
              hitSlop={14}
              className="mt-1 self-start active:opacity-70"
              onPress={action.run}
            >
              <Text className="text-sm font-t3-medium text-primary">{action.label}</Text>
            </Pressable>
          </View>
        ) : (
          <Text className="text-sm text-warning-foreground">
            {resetText ??
              "The provider did not report a reset time. Retry manually when your limit is available."}
          </Text>
        )}
        {canSchedule ? (
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={scheduled ? "Cancel auto-resume" : "Resume at reset"}
              tone="secondary"
              disabled={pending}
              onPress={() => void toggle("resume")}
            />
            <Button
              label={snoozed ? "Wake now" : "Snooze until reset"}
              tone="secondary"
              disabled={pending || (!snoozed && resetPassed)}
              onPress={() => void toggle("snooze")}
            />
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
