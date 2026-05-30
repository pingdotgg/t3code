import type { ApprovalRequestId, ProviderApprovalDecision } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly approval: PendingApproval;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100/80 p-4 dark:border-white/6 dark:bg-neutral-900/80">
      <Text className="font-t3-bold text-[11px] uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        Approval needed
      </Text>
      <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
        {props.approval.requestKind}
      </Text>
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-5 text-neutral-600 dark:text-neutral-400">
          {props.approval.detail}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        <Pressable
          className="items-center justify-center rounded-[14px] bg-blue-500 px-3.5 py-3"
          disabled={props.respondingApprovalId === props.approval.requestId}
          onPress={() => void props.onRespond(props.approval.requestId, "accept")}
        >
          <Text className="font-t3-extrabold text-sm text-white">Allow once</Text>
        </Pressable>
        <Pressable
          className="items-center justify-center rounded-[14px] bg-neutral-200 px-3.5 py-3 dark:bg-neutral-800"
          disabled={props.respondingApprovalId === props.approval.requestId}
          onPress={() => void props.onRespond(props.approval.requestId, "acceptForSession")}
        >
          <Text className="font-t3-bold text-sm text-neutral-950 dark:text-neutral-50">
            Allow session
          </Text>
        </Pressable>
        <Pressable
          className="items-center justify-center rounded-[14px] bg-rose-100 px-3.5 py-3 dark:bg-rose-500/18"
          disabled={props.respondingApprovalId === props.approval.requestId}
          onPress={() => void props.onRespond(props.approval.requestId, "decline")}
        >
          <Text className="font-t3-bold text-sm text-rose-700 dark:text-rose-300">Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}
