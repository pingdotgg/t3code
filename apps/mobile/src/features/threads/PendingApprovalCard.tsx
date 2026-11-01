import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly maxHeight: DerivedValue<number>;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const maxHeight = props.maxHeight;
  const maxHeightStyle = useAnimatedStyle(() => ({ maxHeight: maxHeight.value }));
  return (
    <Animated.View
      className="overflow-hidden gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
      style={maxHeightStyle}
    >
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-2.5"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ flexShrink: 1 }}
      >
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          Approval needed
        </Text>
        <Text className="font-t3-bold text-lg text-foreground">
          {props.approval.appName ?? props.approval.requestKind}
        </Text>
        {props.approval.detail ? (
          <Text className="font-sans text-sm leading-normal text-foreground-secondary">
            {props.approval.detail}
          </Text>
        ) : null}
        {props.approval.reason ? (
          <Text className="font-sans text-xs leading-normal text-warning-foreground">
            {props.approval.reason}
          </Text>
        ) : null}
        {props.approval.fullAccessOverride ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: explanationOpen }}
            onPress={() => setExplanationOpen((open) => !open)}
          >
            <Text className="font-t3-bold text-xs text-foreground-secondary underline">
              {FULL_ACCESS_OVERRIDE_QUESTION}
            </Text>
            {explanationOpen ? (
              <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
                {fullAccessOverrideExplanation(props.approval.fullAccessOverride)}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
      </ScrollView>
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <Button
            key={option.decision}
            label={option.label}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={disabled || !props.canOperateThread}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          />
        ))}
      </View>
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </Animated.View>
  );
}
