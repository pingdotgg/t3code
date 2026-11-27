import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  type ApprovalTextPart,
  approvalTextParts,
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
  PUSH_HOOKS_APPROVAL_QUESTION,
  pushHooksApprovalRows,
} from "@t3tools/client-runtime/state/thread-requests";
import { T, useGT, useMessages } from "gt-react-native";
import { type ComponentRef, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const gt = useGT();
  const m = useMessages();
  const options: ReadonlyArray<ProviderApprovalOption> = props.approval.options ?? [
    { decision: "accept", label: gt("Allow once") },
    { decision: "acceptForSession", label: gt("Allow session") },
    {
      decision: "decline",
      label: gt("Decline", { $context: "verb, rejects the approval request" }),
    },
  ];
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  // T3 Code's own question reads as the app asking: a plain sentence, then what it names.
  const { pushHooks } = props.approval;
  const detail =
    !pushHooks && props.approval.detail ? approvalTextParts(props.approval.detail) : null;
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-semibold text-base text-foreground">
        <T>Approval needed</T>
      </Text>
      <Text className="font-t3-medium text-sm text-foreground-secondary">
        {pushHooks
          ? m(PUSH_HOOKS_APPROVAL_QUESTION)
          : (props.approval.appName ?? props.approval.requestKind)}
      </Text>
      {pushHooks ? (
        <View className="gap-1.5">
          {pushHooksApprovalRows(pushHooks, m).map((row, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- rows never reorder and two hooks may read alike
            <View key={index} className="gap-0.5">
              <Text className="font-sans text-xs text-foreground-muted">{row.label}</Text>
              <Text selectable className="font-sans text-sm leading-normal text-foreground">
                {row.name ? `${row.name}  ` : null}
                <Text className="font-mono text-sm text-foreground">{row.code}</Text>
              </Text>
            </View>
          ))}
        </View>
      ) : props.approval.files && props.approval.files.length > 0 ? (
        <View className="gap-1">
          {props.approval.files.map((file) => (
            <View key={`${file.operation ?? ""}:${file.path}`} className="flex-row gap-2">
              <Text
                className="flex-1 font-sans text-sm text-foreground-secondary"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {file.path}
              </Text>
              {file.additions !== undefined || file.deletions !== undefined ? (
                <Text className="font-mono text-xs text-foreground-secondary">
                  +{file.additions ?? 0} −{file.deletions ?? 0}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : detail ? (
        <>
          {detail.hiddenLength > 0 ? (
            <>
              <ApprovalTextScroll parts={detail.parts} />
              <Text className="font-sans text-xs leading-normal text-warning-foreground">
                {gt(
                  "{count, plural, one {… {hidden} character in the middle is not shown.} other {… {hidden} characters in the middle are not shown.}} The text ends with:",
                  { count: detail.hiddenLength, hidden: detail.hiddenLength.toLocaleString() },
                )}
              </Text>
              <ApprovalTextScroll parts={detail.tail} fromEnd />
            </>
          ) : (
            <ApprovalTextParts parts={detail.parts} />
          )}
        </>
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
            {m(FULL_ACCESS_OVERRIDE_QUESTION)}
          </Text>
          {explanationOpen ? (
            <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
              {fullAccessOverrideExplanation(props.approval.fullAccessOverride, m)}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          <T>
            The provider process for this request is no longer available. Interrupt or restart the
            run to continue.
          </T>
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      <View className="gap-2">
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
            fullWidth
          />
        ))}
      </View>
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          <T>This connection cannot respond to approvals.</T>
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One end of text too long to show in full, in a box that scrolls on its own, so the note, the
 * other end and the buttons stay within reach. The end opens on its last line.
 */
function ApprovalTextScroll(props: {
  readonly parts: ReadonlyArray<ApprovalTextPart>;
  readonly fromEnd?: boolean;
}) {
  const box = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <ScrollView
      ref={box}
      className="max-h-40"
      nestedScrollEnabled
      onContentSizeChange={
        props.fromEnd ? () => box.current?.scrollToEnd({ animated: false }) : undefined
      }
    >
      <ApprovalTextParts parts={props.parts} />
    </ScrollView>
  );
}

function ApprovalTextParts(props: { readonly parts: ReadonlyArray<ApprovalTextPart> }) {
  return (
    <Text className="font-sans text-sm leading-normal text-foreground-secondary">
      {props.parts.map((part, index) =>
        part.named ? (
          // Tinted only: a second font inside wrapped lines makes Android lay the text out shorter
          // than it draws, which cuts off its last lines.
          // oxlint-disable-next-line react/no-array-index-key -- parts never reorder and two may read alike
          <Text key={index} className="text-warning-foreground">
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}
