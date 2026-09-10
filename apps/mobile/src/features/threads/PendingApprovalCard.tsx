import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderApprovalOption,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly approval: PendingApproval;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly onRespond: (
    requestId: ApprovalRequestId,
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
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
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
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <Pressable
            key={option.decision}
            className={`items-center justify-center rounded-[14px] px-3.5 py-3 ${
              option.decision === "accept"
                ? "bg-primary"
                : option.decision === "decline"
                  ? "bg-danger"
                  : "bg-subtle-strong"
            }`}
            disabled={props.respondingApprovalId === props.approval.requestId}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          >
            <Text
              className={`text-sm ${
                option.decision === "accept"
                  ? "font-t3-extrabold text-primary-foreground"
                  : option.decision === "decline"
                    ? "font-t3-bold text-danger-foreground"
                    : "font-t3-bold text-foreground"
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
