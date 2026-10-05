import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useState } from "react";
import { View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Feed card for a secret an agent asked the user for. The typed value lives
 * only in this component's state and the RPC payload: it is never logged,
 * alerted, or persisted, and the field clears once the answer is sent.
 */
const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "secret_request") return null;
  const display = secretRequestDisplay(item, visibility);
  if (display.kind === "pending") {
    return (
      <PendingSecretRequestForm
        environmentId={props.environmentId}
        item={item}
        iconColor={props.iconColor}
      />
    );
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? LOCK_SYMBOL
      : display.outcome === "saved"
        ? "checkmark"
        : "minus";
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {item.label} · {display.label}
      </Text>
    </View>
  );
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerScheduledTaskSecretRequest, {
    label: "scheduled task answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (
    reply: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input });
    setSubmitting(false);
    if (result._tag === "Success") {
      // The card switches to its answered row once the item updates.
      setSecret("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <View className="mb-3 gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row items-start gap-2">
        <View className="pt-0.5">
          <SymbolView name={LOCK_SYMBOL} size={14} tintColor={props.iconColor} type="monochrome" />
        </View>
        <View className="flex-1 gap-1">
          <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
          {item.reason.trim() ? (
            <Text className="font-sans text-sm leading-5 text-foreground-muted">{item.reason}</Text>
          ) : null}
          <Text className="font-sans text-xs text-foreground-muted">
            Stored for this task only. The agent never sees it.
          </Text>
        </View>
      </View>
      <TextInput
        accessibilityLabel={item.label}
        value={secret}
        onChangeText={setSecret}
        editable={!submitting}
        secureTextEntry
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
        returnKeyType="done"
        onSubmitEditing={() => void send({ type: "save", secret })}
      />
      {error !== null ? (
        <Text accessibilityLiveRegion="polite" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <RequestActionButton
            label="Decline"
            tone="secondary"
            disabled={submitting}
            onPress={() => void send({ type: "decline" })}
          />
        </View>
        <View className="flex-1">
          <RequestActionButton
            label="Save"
            disabled={submitting || secret.trim().length === 0}
            onPress={() => void send({ type: "save", secret })}
          />
        </View>
      </View>
    </View>
  );
}
