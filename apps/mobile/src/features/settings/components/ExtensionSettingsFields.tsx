import { useRef, useState } from "react";
import { View } from "react-native";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import type { ExtensionInfo } from "@t3tools/contracts";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";

type Setting = NonNullable<ExtensionInfo["manifest"]["settings"]>[string];

export function ExtensionSettingsFields({
  entry,
  keys,
  disabled,
  save,
}: {
  entry: ExtensionInfo;
  keys?: readonly string[];
  disabled: boolean;
  save: (key: string, value: string | number | boolean) => void;
}) {
  return Object.entries(entry.manifest.settings ?? {})
    .filter(([key]) => !keys || keys.includes(key))
    .map(([key, setting]) => (
      <View key={key} className="gap-1">
        <Text className="font-t3-semibold">{setting.title}</Text>
        <Text className="text-sm leading-5 text-foreground-muted">{setting.description}</Text>
        {setting.type === "boolean" ? (
          <ThemedSwitch
            accessibilityLabel={setting.title}
            value={entry.settings[key] === true}
            disabled={disabled}
            onValueChange={(value) => save(key, value)}
          />
        ) : (
          <TextSetting
            setting={setting}
            value={String(entry.settings[key] ?? setting.default)}
            disabled={disabled}
            save={(value) => save(key, value)}
          />
        )}
      </View>
    ));
}

function TextSetting({
  setting,
  value,
  disabled,
  save,
}: {
  setting: Setting;
  value: string;
  disabled: boolean;
  save: (value: string | number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const focusedValue = useRef(value);
  return (
    <TextInput
      accessibilityLabel={setting.title}
      className="rounded border border-border p-3 text-foreground"
      value={draft ?? value}
      editable={!disabled}
      keyboardType={setting.type === "number" ? "numeric" : "default"}
      onFocus={() => {
        focusedValue.current = value;
      }}
      onChangeText={setDraft}
      onEndEditing={(event) => {
        const text = event.nativeEvent.text;
        setDraft(null);
        if (text !== focusedValue.current && text !== value)
          save(setting.type === "number" ? Number(text) : text);
      }}
    />
  );
}
