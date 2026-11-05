import { pipe } from "effect/Function";
import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestInputs,
  secretRequestPrivacyNote,
  type SecretRequestInput,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View, type ColorValue, type TextInputInstance } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/Button";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const PRIVATE_SYMBOL: AppSymbolName = { ios: "checkmark.shield", android: "lock" };

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
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const inputRefs = useRef<Array<TextInputInstance | null>>([]);
  const inputs = secretRequestInputs(item);
  const multiple = item.fields !== undefined;

  const send = async (reply: Parameters<typeof secretRequestAnswerInput>[1]) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setValues({});
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      pipe(squashAtomCommandFailure(result), secretRequestFailureMessage, setError);
    }
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
        {item.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted" selectable>
            {item.reason}
          </Text>
        ) : null}
      </View>
      {inputs.map((input, index) => {
        const last = index === inputs.length - 1;
        return (
          <SecretRequestField
            key={input.key}
            input={input}
            // A single input is labelled by the card title.
            label={multiple ? input.label : undefined}
            accessibilityLabel={multiple ? input.label : item.label}
            onMount={(instance) => {
              inputRefs.current[index] = instance;
            }}
            value={values[input.key] ?? ""}
            editable={!submitting}
            iconColor={props.iconColor}
            returnKeyType={last ? "done" : "next"}
            onChangeText={(value) => setValues((current) => ({ ...current, [input.key]: value }))}
            onSubmitEditing={() =>
              last ? void send({ type: "save", values }) : inputRefs.current[index + 1]?.focus()
            }
          />
        );
      })}
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <Button
        label="Save securely"
        tone="primary"
        fullWidth
        disabled={submitting || secretRequestAnswerInput(item, { type: "save", values }) === null}
        onPress={() => void send({ type: "save", values })}
      />
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 flex-row items-center gap-1.5">
          <SymbolView
            name={PRIVATE_SYMBOL}
            size={13}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text className="flex-1 font-sans text-xs text-foreground-muted">
            {secretRequestPrivacyNote(item)}
          </Text>
        </View>
        <Button
          label="Decline"
          tone="text"
          disabled={submitting}
          onPress={() => void send({ type: "decline" })}
        />
      </View>
    </View>
  );
}

function SecretRequestField({
  onMount,
  ...props
}: {
  readonly input: SecretRequestInput;
  readonly label: string | undefined;
  readonly accessibilityLabel: string;
  readonly onMount: (instance: TextInputInstance | null) => void;
  readonly value: string;
  readonly editable: boolean;
  readonly iconColor: ColorValue;
  readonly returnKeyType: "next" | "done";
  readonly onChangeText: (value: string) => void;
  readonly onSubmitEditing: () => void;
}) {
  const { input } = props;
  const [revealed, setRevealed] = useState(false);
  return (
    <View className="gap-1.5">
      {props.label === undefined ? null : (
        <Text className="font-t3-medium text-sm text-foreground-muted">{props.label}</Text>
      )}
      <View className="justify-center">
        <TextInput
          ref={onMount}
          accessibilityLabel={props.accessibilityLabel}
          className={input.secret ? "pr-12" : undefined}
          placeholder={input.placeholder}
          value={props.value}
          onChangeText={props.onChangeText}
          editable={props.editable}
          secureTextEntry={input.secret && !revealed}
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          spellCheck={false}
          returnKeyType={props.returnKeyType}
          submitBehavior={props.returnKeyType === "next" ? "submit" : "blurAndSubmit"}
          onSubmitEditing={props.onSubmitEditing}
        />
        {input.secret ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? `Hide ${input.label}` : `Show ${input.label}`}
            accessibilityState={{ selected: revealed }}
            hitSlop={8}
            className="absolute right-1 size-11 items-center justify-center active:opacity-70"
            onPress={() => setRevealed((current) => !current)}
          >
            <SymbolView
              name={revealed ? "eye.slash" : "eye"}
              size={18}
              tintColor={props.iconColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
