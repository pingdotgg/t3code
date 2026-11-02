import { pipe } from "effect/Function";
import { useAtomValue } from "@effect/atom-react";
import {
  delegationApprovalAnswerInput,
  delegationApprovalDisplay,
  delegationApprovalFailureMessage,
  type DelegationApprovalItem,
  delegationSelectionLabel,
} from "@t3tools/client-runtime/delegation-approval";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const BRANCH_SYMBOL: AppSymbolName = "arrow.triangle.branch";

/** An agent asked to delegate a task to a provider, model or options other than its own. */
export function DelegationApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "delegation_approval") return null;
  const display = delegationApprovalDisplay(item, visibility);
  if (display.kind === "pending") {
    return <PendingDelegationApproval environmentId={props.environmentId} item={item} />;
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? BRANCH_SYMBOL
      : display.outcome === "approved"
        ? "checkmark"
        : "minus";
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        Delegate to {delegationSelectionLabel(item.proposed)} · {display.label}
      </Text>
    </View>
  );
}

function PendingDelegationApproval(props: {
  readonly environmentId: EnvironmentId;
  readonly item: DelegationApprovalItem;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerDelegationApproval, {
    label: "answer delegation approval",
    reportFailure: false,
    reportDefect: false,
  });
  const canAnswer = useAtomValue(
    serverEnvironment.answerDelegationApproval.permissionAtom(props.environmentId),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two taps can both land before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (decision: "approve" | "decline") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: delegationApprovalAnswerInput(item, decision),
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      pipe(squashAtomCommandFailure(result), delegationApprovalFailureMessage, setError);
    }
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">
          {item.environmentId === undefined
            ? "Run a subagent on a different model?"
            : "Run a subagent in another environment on a different model?"}
        </Text>
        <Text
          className="font-sans text-sm leading-5 text-foreground-muted"
          numberOfLines={3}
          selectable
        >
          {item.task}
        </Text>
      </View>
      <View className="gap-1">
        <Text className="font-sans text-xs text-foreground-muted">
          This thread: {delegationSelectionLabel(item.current)}
        </Text>
        <Text className="font-sans text-xs text-foreground">
          Subagent: {delegationSelectionLabel(item.proposed)}
          {item.environmentId === undefined ? "" : ` · ${item.environmentId}`}
        </Text>
      </View>
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      {canAnswer ? (
        <View className="flex-row items-center justify-end gap-2">
          <Button
            label="Decline"
            tone="text"
            disabled={submitting}
            onPress={() => void send("decline")}
          />
          <Button
            label="Approve"
            tone="primary"
            disabled={submitting}
            onPress={() => void send("approve")}
          />
        </View>
      ) : (
        <Text className="font-sans text-xs text-foreground-muted">
          Only a session that can run agents here can answer this.
        </Text>
      )}
    </View>
  );
}
