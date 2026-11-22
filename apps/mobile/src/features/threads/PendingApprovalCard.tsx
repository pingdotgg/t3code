import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  APPROVAL_EFFECT,
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
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

const PRIMARY_DECISIONS: ReadonlyArray<ProviderApprovalDecision> = [
  "accept",
  "decline",
  "acceptForSession",
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const gt = useGT();
  const m = useMessages();
  const options: ReadonlyArray<ProviderApprovalOption> = props.approval.options ?? [
    {
      decision: "accept",
      label: gt("Approve", { $context: "verb, response to an approval request" }),
    },
    { decision: "acceptForSession", label: gt("Always allow this session") },
    {
      decision: "decline",
      label: gt("Decline", { $context: "verb, response to an approval request" }),
    },
  ];
  const optionFor = (decision: ProviderApprovalDecision) =>
    options.find((option) => option.decision === decision);
  const accept = optionFor("accept");
  const decline = optionFor("decline");
  const session = optionFor("acceptForSession");
  const moreOptions = options.filter((option) => !PRIMARY_DECISIONS.includes(option.decision));
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled =
    !canRespond ||
    !props.canOperateThread ||
    props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const respond = (decision: ProviderApprovalDecision) =>
    void props.onRespond(props.approval.requestId, decision);
  return (
    <View
      accessibilityLabel={gt("Approval required")}
      className="gap-2 rounded-xl border border-warning-border bg-warning p-3"
    >
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name="exclamationmark.shield"
          size={13}
          tintColorClassName="accent-warning-foreground"
          type="monochrome"
          weight="semibold"
        />
        <Text className="font-t3-bold text-sm text-warning-foreground">
          <T>Approval required</T>
        </Text>
        {props.approval.appName ? (
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            {props.approval.appName}
          </Text>
        ) : null}
      </View>
      <Text className="font-sans text-xs text-foreground-secondary">
        {m(APPROVAL_EFFECT[props.approval.requestKind])}
      </Text>
      {props.approval.detail ? (
        <View className="rounded-lg bg-md-code-bg px-2.5 py-2">
          <Text selectable className="font-mono text-xs leading-5 text-md-code-text">
            {props.approval.detail}
          </Text>
        </View>
      ) : null}
      {props.approval.reason ? (
        <Text className="font-sans text-xs leading-normal text-foreground-secondary">
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
      {accept || decline ? (
        <View className="flex-row gap-2">
          {accept ? (
            <View className="flex-1">
              <Button
                label={accept.label}
                tone="primary"
                size="compact"
                disabled={disabled}
                onPress={() => respond(accept.decision)}
                fullWidth
              />
            </View>
          ) : null}
          {decline ? (
            <View className="flex-1">
              <Button
                label={decline.label}
                tone="secondary"
                size="compact"
                disabled={disabled}
                onPress={() => respond(decline.decision)}
                fullWidth
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {[session, ...moreOptions].map((option) =>
        option ? (
          <Button
            key={option.decision}
            label={option.label}
            tone={option.decision === "acceptForSession" ? "secondary" : "text"}
            size="compact"
            disabled={disabled}
            onPress={() => respond(option.decision)}
            fullWidth
          />
        ) : null,
      )}
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          <T>This connection cannot respond to approvals.</T>
        </Text>
      ) : null}
    </View>
  );
}
