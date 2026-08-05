import type { ApprovalRequestId, ProviderApprovalDecision } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly approval: PendingApproval;
  readonly approvalCount: number;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const APPROVAL_COPY = {
  command: {
    eyebrow: "Command",
    title: "Command approval requested",
  },
  "file-read": {
    eyebrow: "File read",
    title: "File read approval requested",
  },
  "file-change": {
    eyebrow: "File change",
    title: "File change approval requested",
  },
} as const satisfies Record<PendingApproval["requestKind"], { eyebrow: string; title: string }>;

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const copy = APPROVAL_COPY[props.approval.requestKind];
  const isResponding = props.respondingApprovalId === props.approval.requestId;
  const respond = (decision: ProviderApprovalDecision) => {
    void props.onRespond(props.approval.requestId, decision);
  };

  return (
    <View
      accessibilityLabel={copy.title}
      className="overflow-hidden rounded-[22px] border border-border bg-card"
    >
      <View className="gap-2.5 px-4 pb-3.5 pt-3.5">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.2px] text-amber-600 dark:text-amber-300">
            Pending approval
          </Text>
          <Text className="font-t3-medium text-sm tabular-nums text-foreground-tertiary">
            1/{Math.max(1, props.approvalCount)}
          </Text>
        </View>
        <Text className="font-t3-bold text-lg text-foreground">{copy.title}</Text>
        <View className="gap-1.5 rounded-xl border border-border-subtle bg-screen px-3 py-2.5">
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-tertiary">
            {copy.eyebrow}
          </Text>
          <Text selectable className="font-mono text-sm leading-[21px] text-foreground-secondary">
            {props.approval.detail ?? "Review the requested operation before continuing."}
          </Text>
        </View>
      </View>

      <View className="gap-2.5 border-t border-border px-3 pb-3 pt-2.5">
        <View className="flex-row gap-2">
          <Pressable
            accessibilityLabel="Approve once"
            accessibilityRole="button"
            accessibilityState={{ disabled: isResponding }}
            className={cn(
              "min-h-12 flex-1 items-center justify-center rounded-xl bg-blue-600 px-3",
              isResponding && "opacity-50",
            )}
            disabled={isResponding}
            onPress={() => respond("accept")}
          >
            <Text className="font-t3-bold text-base text-white">Approve once</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Always allow for this session"
            accessibilityRole="button"
            accessibilityState={{ disabled: isResponding }}
            className={cn(
              "min-h-12 flex-1 items-center justify-center rounded-xl border border-secondary-border bg-secondary px-3",
              isResponding && "opacity-50",
            )}
            disabled={isResponding}
            onPress={() => respond("acceptForSession")}
          >
            <Text className="font-t3-bold text-base text-secondary-foreground">Always allow</Text>
          </Pressable>
        </View>
        <View className="flex-row items-center justify-center gap-8">
          <Pressable
            accessibilityLabel="Decline approval"
            accessibilityRole="button"
            accessibilityState={{ disabled: isResponding }}
            className={cn("min-h-7 justify-center px-2", isResponding && "opacity-50")}
            disabled={isResponding}
            hitSlop={8}
            onPress={() => respond("decline")}
          >
            <Text className="font-t3-bold text-base text-red-600 dark:text-red-400">Decline</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Cancel turn"
            accessibilityRole="button"
            accessibilityState={{ disabled: isResponding }}
            className={cn("min-h-7 justify-center px-2", isResponding && "opacity-50")}
            disabled={isResponding}
            hitSlop={8}
            onPress={() => respond("cancel")}
          >
            <Text className="font-t3-medium text-base text-foreground-muted">Cancel turn</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
