import { pipe } from "effect/Function";
import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestInputs,
  secretRequestPrivacyNote,
  secretRequestReference,
  secretRequestSources,
  secretRequestValue,
  type SecretRequestInput,
  type SecretRequestItem,
  type SecretRequestReply,
  type SecretRequestSource,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  SecretProviderId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
import type { SecretTextInputHandle } from "../../components/ui/SecretTextInput.types";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const PRIVATE_SYMBOL: AppSymbolName = { ios: "checkmark.shield", android: "lock" };
const NO_SOURCES: ReadonlyArray<SecretRequestSource> = [];

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
  const inputs = secretRequestInputs(item);
  const multiple = item.fields !== undefined;
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  // A reference answers one value, so a card with fields is always typed.
  const sources = multiple
    ? NO_SOURCES
    : secretRequestSources(config, config?.settings.secretProviders ?? {});
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const source = sources.find((candidate) => candidate.id === sourceId) ?? null;
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const inputRefs = useRef<Array<SecretTextInputHandle | null>>([]);

  const send = async (reply: SecretRequestReply) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    // iOS offers to save a masked field that leaves the screen with text in it as a login
    // password, so the card is emptied before it closes; a failed answer puts the values back.
    const typed = reply.type === "save" ? reply.values : values;
    setValues({});
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setReference("");
      return;
    }
    setValues(typed);
    if (!isAtomCommandInterrupted(result)) {
      pipe(squashAtomCommandFailure(result), secretRequestFailureMessage, setError);
    }
  };

  const save = (typed: Readonly<Record<string, string>>) => {
    if (source === null) {
      void send({ type: "save", values: typed });
    } else if (secretRequestReference(source, reference) === undefined) {
      setError(source.invalidReferenceMessage);
    } else {
      void send({ type: "reference", source, reference });
    }
  };
  const canSave =
    source === null
      ? secretRequestAnswerInput(item, { type: "save", values }) !== null
      : reference.trim().length > 0;

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
      {sources.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          <Chip
            label="Value"
            size="small"
            selected={source === null}
            disabled={submitting}
            onPress={() => {
              setSourceId(null);
              setError(null);
            }}
          />
          {sources.map((candidate) => (
            <Chip
              key={candidate.id}
              label={candidate.label}
              size="small"
              selected={candidate.id === source?.id}
              disabled={submitting}
              onPress={() => {
                setSourceId(candidate.id);
                setError(null);
              }}
            />
          ))}
        </View>
      ) : null}
      {source !== null ? (
        <TextInput
          key={source.id}
          accessibilityLabel={`${item.label} reference in ${source.label}`}
          placeholder={source.referencePlaceholder}
          value={reference}
          onChangeText={(next) => {
            setReference(next);
            setError(null);
          }}
          editable={!submitting}
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          spellCheck={false}
          returnKeyType="done"
          onSubmitEditing={() => save(values)}
        />
      ) : (
        inputs.map((input, index) => {
          const last = index === inputs.length - 1;
          return (
            <SecretRequestField
              key={input.key}
              input={input}
              // A single input is labelled by the card title.
              label={multiple ? input.label : undefined}
              accessibilityLabel={multiple ? input.label : item.label}
              onMount={(handle) => {
                inputRefs.current[index] = handle;
              }}
              value={secretRequestValue(values, input.key)}
              editable={!submitting}
              iconColor={props.iconColor}
              returnKeyType={last ? "done" : "next"}
              onChangeText={(value) => setValues((current) => ({ ...current, [input.key]: value }))}
              onSubmitEditing={(value) =>
                last
                  ? save({ ...values, [input.key]: value })
                  : inputRefs.current[index + 1]?.focus()
              }
            />
          );
        })
      )}
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
        disabled={submitting || !canSave}
        onPress={() => save(values)}
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
  readonly onMount: (handle: SecretTextInputHandle | null) => void;
  readonly value: string;
  readonly editable: boolean;
  readonly iconColor: ColorValue;
  readonly returnKeyType: "next" | "done";
  readonly onChangeText: (value: string) => void;
  readonly onSubmitEditing: (value: string) => void;
}) {
  const { input } = props;
  const [revealed, setRevealed] = useState(false);
  return (
    <View className="gap-1.5">
      {props.label === undefined ? null : (
        <Text className="font-t3-medium text-sm text-foreground-muted">{props.label}</Text>
      )}
      <View className="justify-center">
        <SecretTextInput
          onMount={onMount}
          accessibilityLabel={props.accessibilityLabel}
          className={input.secret ? "pr-12" : undefined}
          placeholder={input.placeholder}
          value={props.value}
          onChangeText={props.onChangeText}
          editable={props.editable}
          revealed={!input.secret || revealed}
          returnKeyType={props.returnKeyType}
          onSubmitEditing={props.onSubmitEditing}
        />
        {input.secret ? (
          <Pressable
            accessibilityRole="togglebutton"
            accessibilityLabel={`Show ${input.label}`}
            accessibilityState={{ checked: revealed }}
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
