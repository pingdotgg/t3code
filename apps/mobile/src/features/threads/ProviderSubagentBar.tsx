import {
  formatProviderSubagentStatus,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Replaces the composer on a provider-native subagent thread. The provider
 * runs that conversation, so there is nothing to send; the bar says which
 * model is working, for how long, and leads back to the parent.
 */
export function ProviderSubagentBar(props: {
  /** Driver and catalog icon of the provider running the subagent. */
  readonly provider: { readonly driver: string; readonly iconUrl?: string | undefined } | null;
  readonly modelLabel: string;
  /** Reasoning effort as the composer names it, when the subagent has one. */
  readonly effortLabel: string | null;
  /** Null until the subagent's root turn arrives. */
  readonly status: ProviderSubagentStatus | null;
  readonly onOpenParent: (() => void) | null;
}) {
  const live = props.status !== null && isOrchestrationV2WorkActive(props.status.status);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [live]);
  const statusLabel = formatProviderSubagentStatus(props.status, nowMs);
  const modelDescription =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;

  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      {/* Only the text is one element, so "Open parent" stays reachable. */}
      <View
        accessible
        accessibilityLabel={`${modelDescription} subagent, ${statusLabel}. It runs on its own and cannot take messages.`}
        className="min-w-0 flex-1 gap-0.5"
      >
        <View className="min-w-0 flex-row items-center gap-1.5">
          {props.provider ? (
            <ProviderIcon
              iconUrl={props.provider.iconUrl}
              provider={props.provider.driver}
              size={16}
            />
          ) : null}
          <Text numberOfLines={1} className="min-w-0 shrink font-t3-bold text-sm text-foreground">
            {props.modelLabel}
          </Text>
          {props.effortLabel === null ? null : (
            <Text
              numberOfLines={1}
              className="shrink-0 font-sans text-sm text-foreground-secondary"
            >
              {props.effortLabel}
            </Text>
          )}
        </View>
        <Text
          numberOfLines={1}
          className="font-sans text-xs text-foreground-secondary"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {statusLabel} · Runs on its own
        </Text>
      </View>
      {props.onOpenParent ? (
        <RequestActionButton label="Open parent" tone="secondary" onPress={props.onOpenParent} />
      ) : null}
    </View>
  );
}
