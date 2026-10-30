import { CodexSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

const definition = {
  settingsSchema: Schema.Struct({ isolateChats: CodexSettings.fields.isolateChats }),
};

export function ProviderChatIsolationSetting({
  value,
  onChange,
  idPrefix,
}: {
  readonly value: unknown;
  readonly onChange: (config: Record<string, unknown> | undefined) => void;
  readonly idPrefix: string;
}) {
  return (
    <ProviderSettingsForm
      definition={definition}
      value={value}
      onChange={onChange}
      idPrefix={idPrefix}
      variant="settings"
    />
  );
}
