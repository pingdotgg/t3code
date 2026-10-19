import {
  DEFAULT_WEB_TOOL_PROVIDER,
  WebToolProvider,
  type EnvironmentId,
  type WebSettings,
} from "@t3tools/contracts";
import {
  WEB_PROVIDER_DESCRIPTION,
  WEB_TOOL_API_KEYS,
  WEB_TOOL_PROVIDER_LABELS,
} from "@t3tools/client-runtime/web-tool-providers";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useUpdateScopedSettings } from "./useScopedSettings";

function WebProviderRow() {
  const { targets } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const providers = new Set(targets.map((target) => target.settings.web.provider));
  const provider = providers.size === 1 ? [...providers][0]! : null;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["web"]}
      {...searchableSetting("web-provider")}
      description={WEB_PROVIDER_DESCRIPTION}
      resetAction={
        provider !== DEFAULT_WEB_TOOL_PROVIDER ? (
          <SettingResetButton
            label="web provider"
            onClick={() => updateSettings({ web: { provider: DEFAULT_WEB_TOOL_PROVIDER } })}
          />
        ) : null
      }
      control={
        <Select
          value={provider}
          onValueChange={(value) => {
            if (WebToolProvider.literals.includes(value as WebToolProvider)) {
              updateSettings({ web: { provider: value as WebToolProvider } });
            }
          }}
        >
          <SelectTrigger size="sm" aria-label="Web provider">
            <SelectValue>
              {(value: WebToolProvider | null) =>
                value === null ? "Mixed" : WEB_TOOL_PROVIDER_LABELS[value]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WebToolProvider.literals.map((value) => (
              <SelectItem key={value} value={value}>
                {value === DEFAULT_WEB_TOOL_PROVIDER
                  ? `${WEB_TOOL_PROVIDER_LABELS[value]} (default)`
                  : WEB_TOOL_PROVIDER_LABELS[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/**
 * The selected provider's API key on one environment. Keys are write-only: the
 * server keeps them in its secret store and only reports whether one is set.
 */
function WebApiKeyRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.web);
  if (saved.provider === "builtin") return null;
  return (
    // A draft belongs to one provider's key; switching must not save it as another's.
    <WebApiKeyField
      key={saved.provider}
      environmentId={environmentId}
      provider={saved.provider}
      isSaved={saved[WEB_TOOL_API_KEYS[saved.provider].field].length > 0}
    />
  );
}

function WebApiKeyField({
  environmentId,
  provider,
  isSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: Exclude<WebToolProvider, "builtin">;
  readonly isSaved: boolean;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save web provider API key",
  });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const info = WEB_TOOL_API_KEYS[provider];
  const label = WEB_TOOL_PROVIDER_LABELS[provider];

  const save = async (key: string) => {
    setSaving(true);
    try {
      const patch: Partial<WebSettings> = { [info.field]: key };
      const result = await updateSettings({ environmentId, input: { patch: { web: patch } } });
      if (result._tag === "Success") setDraft("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("web-provider-api-key")}
      title={`${label} API key`}
      description={
        <>
          {info.description}{" "}
          <InlineButton render={<a href={info.link} target="_blank" rel="noreferrer noopener" />}>
            Get an API key
            <ExternalLinkIcon aria-hidden className="size-3" />
          </InlineButton>
        </>
      }
    >
      <form
        className="flex max-w-2xl items-center gap-2 pb-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) void save(draft.trim());
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          size="sm"
          aria-label={`${label} API key`}
          placeholder={isSaved ? "Stored secret, enter a new value to replace" : "Not set"}
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
        />
        {isSaved ? (
          <Button size="xs" variant="outline" disabled={saving} onClick={() => void save("")}>
            Remove
          </Button>
        ) : null}
        <Button type="submit" size="xs" disabled={saving || draft.trim() === ""}>
          Save
        </Button>
      </form>
    </SettingsRow>
  );
}

/** The Web tab of Settings → Tools. */
export function WebToolsPanel() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;

  return (
    <SettingsSection title="Web search and fetch">
      <WebProviderRow />
      {environmentId === null ? null : (
        // Drafts belong to one environment; switching must not carry them over.
        <WebApiKeyRow key={environmentId} environmentId={environmentId} />
      )}
    </SettingsSection>
  );
}
