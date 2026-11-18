import { Button } from "../../components/ui/Button";
import {
  httpPageUrl,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
  MCP_URL_ELICITATION_HINT,
} from "@t3tools/client-runtime/state/thread-requests";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
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
  const [linkError, setLinkError] = useState(false);
  const elicitationUrl = props.approval.elicitationUrl
    ? httpPageUrl(props.approval.elicitationUrl)
    : null;
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        <T>Approval needed</T>
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        {props.approval.appName ?? props.approval.requestKind}
      </Text>
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {props.approval.detail}
        </Text>
      ) : null}
      {elicitationUrl && canRespond ? (
        <View className="gap-2">
          <Text className="font-sans text-sm text-foreground-secondary">
            {m(MCP_URL_ELICITATION_HINT)}
          </Text>
          <Text selectable className="font-mono text-xs text-foreground-secondary">
            {elicitationUrl.href}
          </Text>
          <Button
            label={gt("Open {host}", { host: elicitationUrl.host })}
            fullWidth
            tone="secondary"
            disabled={disabled || !props.canOperateThread}
            onPress={() => {
              setLinkError(false);
              void tryOpenExternalUrl(elicitationUrl.href, "mcp-elicitation").then((opened) =>
                setLinkError(!opened),
              );
            }}
          />
          {linkError ? (
            <Text accessibilityRole="alert" className="font-sans text-xs text-danger-foreground">
              <T>Could not open the link. Copy it into your browser to continue.</T>
            </Text>
          ) : null}
        </View>
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
