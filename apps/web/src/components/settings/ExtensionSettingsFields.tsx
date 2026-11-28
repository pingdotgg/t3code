import type { ExtensionInfo } from "@t3tools/contracts";
import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

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
      <label key={key} className="block space-y-1 text-sm">
        <span className="block font-medium">{setting.title}</span>
        <span className="block text-xs text-muted-foreground">{setting.description}</span>
        {setting.type === "boolean" ? (
          <Switch
            aria-label={setting.title}
            checked={entry.settings[key] === true}
            disabled={disabled}
            onCheckedChange={(checked) => save(key, checked)}
          />
        ) : (
          <TextSetting
            setting={setting}
            value={String(entry.settings[key] ?? setting.default)}
            disabled={disabled}
            save={(value) => save(key, value)}
          />
        )}
      </label>
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
  const editor = useCommitOnBlur(value, (text) =>
    save(setting.type === "number" ? Number(text) : text),
  );
  return (
    <Input
      aria-label={setting.title}
      type={setting.type === "number" ? "number" : "text"}
      disabled={disabled}
      {...editor}
    />
  );
}
