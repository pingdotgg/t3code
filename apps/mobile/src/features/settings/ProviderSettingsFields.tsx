import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigFieldBoolean,
  readProviderConfigFieldString,
  type ProviderSettingsFieldModel,
  type SettingsFormDefinition,
} from "@t3tools/client-runtime/settings/provider-form-fields";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
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
  if (fields.length === 0) return null;
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
    </SettingsSection>
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
  const saved = readProviderConfigFieldString(props.value, props.field.key);
  const redacted = props.secure && saved.length > 0;
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
        placeholder={redacted ? "Saved on the host" : props.field.placeholder}
        secureTextEntry={props.secure}
        multiline={props.multiline}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        value={shown}
        onChangeText={setDraft}
        onEndEditing={() => {
          if (redacted && draft.trim().length === 0) return;
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
