import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimits";
import { useCallback } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function environmentSupportsAutoContinue(environmentId: EnvironmentId) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadAutoContinue === true
  );
}

/**
 * "Continue when the limit resets" for a thread stopped by a provider usage
 * limit: offers scheduling while the session error carries a structured reset
 * instant, and shows the pending continuation with a cancel once scheduled.
 * Hidden on servers that predate thread.auto-continue (version skew).
 */
export function AutoContinueBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationThreadShell;
}) {
  const setAutoContinue = useAtomCommand(threadEnvironment.setAutoContinue, {
    reportFailure: false,
  });
  const clearAutoContinue = useAtomCommand(threadEnvironment.clearAutoContinue, {
    reportFailure: false,
  });
  const { environmentId, thread } = props;
  const resetsAt = thread.session?.lastErrorLimitResetsAt ?? null;
  const scheduledFor = thread.autoContinueAt ?? null;

  const schedule = useCallback(() => {
    if (resetsAt === null) return;
    void setAutoContinue({
      environmentId,
      input: { threadId: thread.id, autoContinueAt: resetsAt },
    });
  }, [environmentId, resetsAt, setAutoContinue, thread.id]);
  const cancel = useCallback(() => {
    void clearAutoContinue({
      environmentId,
      input: { threadId: thread.id, reason: "user" },
    });
  }, [clearAutoContinue, environmentId, thread.id]);

  if (!environmentSupportsAutoContinue(environmentId)) return null;
  const now = Date.now();
  if (scheduledFor !== null) {
    const waitMs = Date.parse(scheduledFor) - now;
    return (
      <View className="shrink-0 px-4 pb-3">
        <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3">
          <Text className="flex-1 text-sm text-muted-foreground">
            {waitMs > 0
              ? `Continuing when the limit resets, in ${formatDuration(waitMs)}`
              : "Continuing when the limit resets"}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={cancel}
            className="rounded-full bg-secondary px-4 py-2"
          >
            <Text className="text-sm">Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  const isLimitError =
    thread.session?.status === "error" && resetsAt !== null && Date.parse(resetsAt) > now;
  if (!isLimitError || resetsAt === null) return null;
  return (
    <View className="shrink-0 px-4 pb-3">
      <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3">
        <Text className="flex-1 text-sm text-muted-foreground">
          Usage limit reached. Resets in {formatDuration(Date.parse(resetsAt) - now)}.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={schedule}
          className="rounded-full bg-secondary px-4 py-2"
        >
          <Text className="text-sm">Continue on reset</Text>
        </Pressable>
      </View>
    </View>
  );
}
