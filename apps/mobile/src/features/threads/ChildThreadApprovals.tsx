import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";
import { AppText } from "../../components/ui/AppText";
import { childThreadApprovalsAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { PendingApprovalCard } from "./PendingApprovalCard";

function ChildApproval({ entry }: { entry: ChildThreadApproval }) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="mx-3.5 my-2 gap-2">
      <AppText className="font-t3-bold text-sm text-foreground">
        Approval from {entry.title}
      </AppText>
      <PendingApprovalCard
        canOperateThread={canRespond}
        approval={entry.approval}
        respondingApprovalId={responding ? entry.approval.requestId : null}
        onRespond={async (requestId, decision) => {
          if (!canRespond || responding) return;
          setResponding(true);
          setError(null);
          const result = await respond({
            environmentId: entry.thread.environmentId,
            input: { threadId: entry.thread.threadId, requestId, decision },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setError(
              failure instanceof Error ? failure.message : "Failed to submit approval decision.",
            );
          }
          setResponding(false);
          return result;
        }}
      />
      {error !== null ? (
        <AppText
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

export function ChildThreadApprovals({
  threadRef,
  maxHeight,
}: {
  threadRef: ScopedThreadRef | null;
  maxHeight: DerivedValue<number>;
}) {
  const approvals = useAtomValue(childThreadApprovalsAtom(threadRef));
  const heightStyle = useAnimatedStyle(() => ({ maxHeight: Math.min(320, maxHeight.value / 2) }));
  if (approvals.length === 0) return null;
  return (
    <Animated.View style={heightStyle} className="overflow-hidden">
      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ flexShrink: 1 }}>
        {approvals.map((entry) => (
          <ChildApproval
            key={JSON.stringify([
              entry.thread.environmentId,
              entry.thread.threadId,
              entry.approval.requestId,
            ])}
            entry={entry}
          />
        ))}
      </ScrollView>
    </Animated.View>
  );
}
