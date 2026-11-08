import { SpeechPostProcessingProvider } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
  useScopedSettingsWriteAllowed,
} from "./useScopedSettings";

const CLEANUP_PROVIDER_LABELS: Record<SpeechPostProcessingProvider, string> = {
  agent: "Agent provider",
  openai: "OpenAI API (BYOK)",
  compatible: "OpenAI-compatible endpoint",
  anthropic: "Anthropic API",
  openrouter: "OpenRouter",
};

function CleanupApiForm({
  provider,
}: {
  provider: Exclude<SpeechPostProcessingProvider, "agent">;
}) {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const canManage = useScopedSettingsWriteAllowed();
  const [key, setKey] = useState("");
  const credential = {
    openai: "openaiPostProcessing",
    compatible: "compatiblePostProcessing",
    anthropic: "anthropicPostProcessing",
    openrouter: "openrouterPostProcessing",
  } as const;
  const slot = credential[provider];
  const config = provider === "openai" ? null : settings.speechPostProcessingApiEndpoints[provider];
  const model = config?.model ?? settings.speechPostProcessingOpenAIModel;
  const label = CLEANUP_PROVIDER_LABELS[provider];
  const saveModel = (value: string) => {
    if (!value || value === model) return;
    if (provider === "openai") update({ speechPostProcessingOpenAIModel: value });
    else update({ speechPostProcessingApiEndpoints: { [provider]: { model: value } } });
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={[
        provider === "openai"
          ? "speechPostProcessingOpenAIModel"
          : "speechPostProcessingApiEndpoints",
        "voiceApiCredentials",
      ]}
      title={`${label} cleanup`}
      description={
        provider === "compatible"
          ? "Sends the transcript and nearby draft text to your Chat Completions endpoint. The API key is optional for servers that do not require one."
          : `Sends the transcript and nearby draft text directly to ${label} without starting an agent. Each provider keeps its own key and model.`
      }
    >
      <div className="grid gap-3 py-3">
        {config && (
          <Input
            key={config.endpoint}
            disabled={!canManage}
            aria-label="Cleanup API base URL"
            defaultValue={config.endpoint}
            placeholder="http://127.0.0.1:1234/v1"
            maxLength={2048}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== config.endpoint && provider !== "openai")
                update({ speechPostProcessingApiEndpoints: { [provider]: { endpoint: value } } });
            }}
          />
        )}
        <Input
          key={model}
          disabled={!canManage}
          aria-label={provider === "openai" ? "OpenAI cleanup model" : `${label} cleanup model`}
          defaultValue={model}
          placeholder={provider === "openai" ? "gpt-4.1-mini" : "Model ID"}
          maxLength={200}
          onBlur={(event) => saveModel(event.target.value.trim())}
        />
        <SecretInput
          aria-label={`${label} cleanup API key`}
          disabled={!canManage}
          configured={Boolean(settings.voiceApiCredentials[slot])}
          placeholder={provider === "compatible" ? "API key (optional)" : "API key"}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!canManage || !key.trim()}
            onClick={() => {
              const value = key.trim();
              update({ voiceApiCredentials: { [slot]: value } }, { onFailed: () => setKey(value) });
              setKey("");
            }}
          >
            Save API key
          </Button>
          {settings.voiceApiCredentials[slot] && (
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage}
              onClick={() => update({ voiceApiCredentials: { [slot]: "" } })}
            >
              Remove API key
            </Button>
          )}
        </div>
      </div>
    </SettingsRow>
  );
}

export function CleanupApiSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const canManage = useScopedSettingsWriteAllowed();
  const provider = settings.speechPostProcessingProvider;
  return (
    <>
      <SettingsRow
        {...searchableSetting("speech-cleanup-provider")}
        serverScoped
        settingKeys={["speechPostProcessingProvider"]}
        title="Cleanup provider"
        description="Choose an agent provider or a direct API endpoint for transcript cleanup."
        control={
          <Select
            value={provider}
            disabled={!canManage}
            onValueChange={(value) => {
              const next = SpeechPostProcessingProvider.literals.find(
                (candidate) => candidate === value,
              );
              if (next) update({ speechPostProcessingProvider: next });
            }}
          >
            <SelectTrigger size="sm" aria-label="Cleanup provider">
              <SelectValue>{CLEANUP_PROVIDER_LABELS[provider]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {SpeechPostProcessingProvider.literals.map((value) => (
                <SelectItem key={value} value={value}>
                  {CLEANUP_PROVIDER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {provider !== "agent" && <CleanupApiForm key={provider} provider={provider} />}
    </>
  );
}
