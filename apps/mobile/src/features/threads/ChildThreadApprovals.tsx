import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import type {
  ChildThreadApproval,
  ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";
import { AppText } from "../../components/ui/AppText";
import { childThreadApprovalsAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { PendingApprovalCard } from "./PendingApprovalCard";

/** Another thread's pending approval, answered on that thread. */
export function OtherThreadApproval({
  thread,
  approval,
}: {
  thread: ScopedThreadRef;
  approval: ThreadPendingApproval;
}) {
  const gt = useGT();
  const connected = Option.isSome(usePreparedConnection(thread.environmentId));
  const canRespond =
    useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope) && connected;
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PendingApprovalCard
        canOperateThread={canRespond}
        approval={approval}
        respondingApprovalId={responding ? approval.requestId : null}
        {...(connected ? {} : { unavailableNotice: gt("Not connected") })}
        onRespond={async (requestId, decision) => {
          if (!canRespond || responding) return;
          setResponding(true);
          setError(null);
          const result = await respond({
            environmentId: thread.environmentId,
            input: { threadId: thread.threadId, requestId, decision },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setError(
              failure instanceof Error
                ? failure.message
                : gt("Failed to submit approval decision."),
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
    </>
  );
}

function ChildApproval({ entry }: { entry: ChildThreadApproval }) {
  return (
    <View className="mx-3.5 my-2 gap-2">
      <AppText className="font-t3-bold text-sm text-foreground">
        <T>
          Approval from <Var>{entry.title}</Var>
        </T>
      </AppText>
      <OtherThreadApproval thread={entry.thread} approval={entry.approval} />
    </View>
  );
}

export function ChildThreadApprovals({
  threadRef,
  maxHeight,
  hideWorkers = false,
}: {
  threadRef: ScopedThreadRef | null;
  maxHeight: DerivedValue<number>;
  /** A Bot's chat shows its workers' requests itself. */
  hideWorkers?: boolean;
}) {
  const allApprovals = useAtomValue(childThreadApprovalsAtom(threadRef));
  const approvals = hideWorkers ? allApprovals.filter((entry) => !entry.worker) : allApprovals;
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
