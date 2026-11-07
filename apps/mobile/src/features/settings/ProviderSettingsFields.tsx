import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigFieldBoolean,
  readProviderConfigFieldString,
  reconcileRowsDraft,
  seedRowsDraft,
  type ProviderSettingsFieldModel,
  type SettingsFormDefinition,
} from "@t3tools/client-runtime/settings/provider-form-fields";
import { isSecretReference } from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsSection } from "./components/SettingsSection";
import * as Dialog from "../../components/ui/Dialog";

export function ProviderSettingsFields(props: {
  readonly definition: SettingsFormDefinition;
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}) {
  const fields = deriveProviderSettingsFields(props.definition, props.value);
  const isLocalAcp =
    props.definition.driverKind === "acpRegistry" &&
    readProviderConfigFieldString(props.value, "source") === "local";
  if (fields.length === 0 && !isLocalAcp) return null;
  return (
    <SettingsSection title="Runtime">
      {fields.map((field) => (
        <ProviderSettingsField
          key={field.key}
          field={field}
          value={props.value}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      ))}
      {isLocalAcp ? (
        <ProviderCommandArguments
          value={props.value}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      ) : null}
    </SettingsSection>
  );
}

let commandArgumentDraftId = 0;

const makeCommandArgumentDraftRow = (value: string) => ({
  id: `provider-argument-${commandArgumentDraftId++}`,
  value,
});

const toCommandArgumentRows = (args: ReadonlyArray<string>) =>
  args.map(makeCommandArgumentDraftRow);

function commandArgumentsEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

function configuredCommandArgs(value: unknown): ReadonlyArray<string> {
  const configured =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>).commandArgs
      : undefined;
  return Array.isArray(configured)
    ? configured.filter((argument): argument is string => typeof argument === "string")
    : [];
}

function ProviderCommandArguments(props: {
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}) {
  const args = configuredCommandArgs(props.value);
  const [storedDraft, setDraft] = useState(() => seedRowsDraft(args, toCommandArgumentRows));
  const draft = reconcileRowsDraft(storedDraft, args, commandArgumentsEqual, toCommandArgumentRows);
  if (draft !== storedDraft) setDraft(draft);
  const rows = draft.rows;

  const updateArguments = (nextRows: typeof rows) => {
    const next = nextRows.map((row) => row.value);
    setDraft({ rows: nextRows, seen: draft.seen, lastPublished: next });
    const config =
      props.value !== null && typeof props.value === "object"
        ? { ...(props.value as Record<string, unknown>) }
        : {};
    props.onChange({ ...config, commandArgs: next });
  };

  return (
    <View className="gap-2 border-b border-border-subtle px-4 py-3">
      <Text className="text-base text-foreground">Arguments</Text>
      <Text className="text-sm text-foreground-muted">
        One literal argument per row, in launch order.
      </Text>
      {rows.map((argument, index) => (
        <View key={argument.id} className="flex-row items-center gap-2">
          <TextInput
            accessibilityLabel={`Argument ${index + 1}`}
            className="min-w-0 flex-1 rounded-lg border border-border-subtle px-3 py-2 font-mono text-base text-foreground"
            placeholderTextColorClassName="accent-foreground-muted"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
            value={argument.value}
            onChangeText={(next) =>
              setDraft({
                rows: rows.map((current) =>
                  current.id === argument.id ? { ...current, value: next } : current,
                ),
                seen: draft.seen,
                lastPublished: draft.lastPublished,
              })
            }
            onEndEditing={() => {
              const next = rows.map((row) => row.value);
              if (commandArgumentsEqual(next, args)) return;
              updateArguments(rows);
            }}
          />
          {!props.disabled ? (
            <Button
              label="Remove"
              tone="text"
              size="compact"
              onPress={() => updateArguments(rows.filter((current) => current.id !== argument.id))}
            />
          ) : null}
        </View>
      ))}
      {!props.disabled ? (
        <Button
          label="Add argument"
          tone="secondary"
          size="compact"
          onPress={() => updateArguments([...rows, makeCommandArgumentDraftRow("")])}
        />
      ) : null}
    </View>
  );
}

function ProviderSettingsField(props: {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}) {
  const { field, value, disabled, onChange } = props;
  if (field.control === "switch") {
    return (
      <SettingsSwitchRow
        label={field.label}
        subtitle={field.description}
        value={readProviderConfigFieldBoolean(value, field.key, field.defaultBooleanValue)}
        disabled={disabled}
        onValueChange={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
      />
    );
  }
  if (field.control === "select") {
    const options = field.options ?? [];
    const fallback = options[0]?.value ?? "";
    const current = readProviderConfigFieldString(value, field.key) || fallback;
    return (
      <View className="gap-1 border-b border-border-subtle px-4 py-3">
        <Text className="text-base text-foreground">{field.label}</Text>
        {field.description ? (
          <Text className="text-sm text-foreground-muted">{field.description}</Text>
        ) : null}
        <View className="mt-2 gap-1">
          {options.map((option) => (
            <ListChoiceRow
              key={option.value}
              label={option.label}
              selected={current === option.value}
              disabled={disabled}
              onPress={() =>
                onChange(
                  nextProviderConfigWithFieldValue(
                    value,
                    field,
                    option.value === fallback ? "" : option.value,
                  ),
                )
              }
            />
          ))}
        </View>
      </View>
    );
  }
  return (
    <TextSettingsField
      field={field}
      value={value}
      disabled={disabled}
      secure={field.control === "password" || field.secret === true}
      multiline={field.control === "textarea"}
      onChange={onChange}
    />
  );
}

function TextSettingsField(props: {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly secure?: boolean;
  readonly multiline?: boolean;
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}) {
  const raw =
    props.value !== null && typeof props.value === "object"
      ? (props.value as Record<string, unknown>)[props.field.key]
      : undefined;
  const hasSecretReference = isSecretReference(raw);
  const saved = typeof raw === "string" ? raw : "";
  const redacted = hasSecretReference || (props.secure === true && saved.length > 0);
  const [draft, setDraft] = useState(redacted ? "" : saved);
  const shown = redacted && draft.length === 0 ? "" : draft;

  return (
    <View className="gap-1 border-b border-border-subtle px-4 py-3">
      <Text className="text-base text-foreground">{props.field.label}</Text>
      {props.field.description ? (
        <Text className="text-sm text-foreground-muted">{props.field.description}</Text>
      ) : null}
      <TextInput
        accessibilityLabel={props.field.label}
        className="mt-1 rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={
          hasSecretReference
            ? "Linked secret on the host"
            : redacted
              ? "Saved on the host"
              : props.field.placeholder
        }
        secureTextEntry={props.secure}
        multiline={props.multiline}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        value={shown}
        onChangeText={setDraft}
        onEndEditing={() => {
          if (redacted ? draft.trim().length === 0 : draft === saved) return;
          props.onChange(nextProviderConfigWithFieldValue(props.value, props.field, draft));
        }}
      />
      {redacted && !props.disabled ? (
        <Text
          className="text-sm text-accent"
          onPress={() => {
            Dialog.alert("Clear saved secret?", "The host will forget the stored value.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Clear",
                style: "destructive",
                onPress: () => {
                  setDraft("");
                  props.onChange(nextProviderConfigWithFieldValue(props.value, props.field, ""));
                },
              },
            ]);
          }}
        >
          Clear saved value
        </Text>
      ) : null}
    </View>
  );
}
