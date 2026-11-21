import { executeProjectSync } from "@lathe/client-runtime/state/project-sync";
import { settlePromise, squashAtomCommandFailure } from "@lathe/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@lathe/contracts";
import * as Option from "effect/Option";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { runtime } from "../../lib/runtime";
import { usePreparedConnection } from "../../state/session";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

export function SyncedConversation({
  environmentId,
  threadId,
  bottomInset,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  bottomInset: number;
}) {
  const prepared = usePreparedConnection(environmentId);
  const selectDetail = useSelectWorkspaceDetail();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const continueInFork = async () => {
    if (Option.isNone(prepared) || pending) return;
    setPending(true);
    setError(null);
    const result = await settlePromise(() =>
      runtime.runPromise(executeProjectSync(prepared.value, { operation: "continue", threadId })),
    );
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (result.value.threadId)
      selectDetail({
        name: "Thread",
        params: { environmentId, threadId: result.value.threadId },
      });
  };
  return (
    <View className="gap-3 bg-screen px-4 pt-4" style={{ paddingBottom: bottomInset + 12 }}>
      <Text className="text-base font-semibold text-foreground">From T3 Code</Text>
      <Text className="text-sm text-foreground-muted">
        This conversation is synced from your main install. Continue in fork to work independently
        with its history.
      </Text>
      {error !== null ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground">
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={pending || Option.isNone(prepared)}
        onPress={() => void continueInFork()}
        className="min-h-12 items-center justify-center rounded-xl border border-border px-4 py-3"
      >
        <Text className="font-semibold text-foreground">
          {pending ? "Working…" : "Continue in fork"}
        </Text>
      </Pressable>
    </View>
  );
}
