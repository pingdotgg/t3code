import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getSpeechCleanupModels } from "@t3tools/client-runtime/voice-input";
import {
  SpeechPostProcessingProvider,
  SpeechCleanupReasoning,
  type SpeechCleanupApiProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { inEnvironmentSpeechRuntime } from "../../speech/runEnvironmentSpeech";
import { usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  useComboboxFilter,
} from "../ui/combobox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
  useScopedSettingsWriteAllowed,
} from "./useScopedSettings";

const LABELS: Record<SpeechPostProcessingProvider, string> = {
  agent: "Agent provider",
  openai: "OpenAI API (BYOK)",
  compatible: "OpenAI-compatible endpoint",
  anthropic: "Anthropic API",
  openrouter: "OpenRouter",
  opencode: "OpenCode (raw generation)",
};
function useCleanupModels(
  prepared: PreparedConnection | null,
  provider: SpeechCleanupApiProvider,
  endpoint: string,
  configured: boolean,
) {
  const atom = Atom.make(
    prepared && endpoint && (configured || provider === "compatible")
      ? inEnvironmentSpeechRuntime(getSpeechCleanupModels(prepared, provider))
      : Effect.succeed(null),
  );
  return [useAtomValue(atom), useAtomRefresh(atom)] as const;
}

function CleanupApiForm({ provider }: { provider: SpeechCleanupApiProvider }) {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const canManage = useScopedSettingsWriteAllowed();
  const { environment } = useSettingsScope();
  const prepared = Option.getOrNull(usePreparedConnection(environment?.environmentId ?? null));
  const [key, setKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"idle" | "saving" | "failed">("idle");
  const slot = `${provider}PostProcessing` as const;
  const configured = Boolean(settings.voiceApiCredentials[slot]);
  const config = provider === "openai" ? null : settings.speechPostProcessingApiEndpoints[provider];
  const model = config?.model ?? settings.speechPostProcessingOpenAIModel;
  const label = LABELS[provider];
  const { contains } = useComboboxFilter();
  const endpoint = config?.endpoint ?? "https://api.openai.com/v1";
  const canLoadModels = Boolean(endpoint) && (configured || provider === "compatible");
  const [catalog, refresh] = useCleanupModels(prepared, provider, endpoint, configured);
  const models = AsyncResult.isSuccess(catalog) ? (catalog.value?.models ?? []) : [];
  const saveModel = (value: string) => {
    if (!value || value === model) return;
    if (provider === "openai") update({ speechPostProcessingOpenAIModel: value });
    else update({ speechPostProcessingApiEndpoints: { [provider]: { model: value } } });
  };
  const saveKey = (value: string) => {
    setKeyStatus("saving");
    update(
      { voiceApiCredentials: { [slot]: value } },
      {
        onFailed: () => setKeyStatus("failed"),
        onSaved: () => {
          setKey("");
          setKeyStatus("idle");
          refresh();
        },
      },
    );
  };
  const reasoning =
    provider === "openai"
      ? settings.speechPostProcessingOpenAIReasoning
      : settings.speechPostProcessingAnthropicReasoning;
  const levels =
    provider === "anthropic"
      ? (models.find((entry) => entry.id === model)?.reasoningLevels ?? [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ])
      : SpeechCleanupReasoning.literals;
  return (
    <SettingsRow
      serverScoped
      settingKeys={[
        provider === "openai"
          ? "speechPostProcessingOpenAIModel"
          : "speechPostProcessingApiEndpoints",
        "voiceApiCredentials",
        ...(provider === "openai" ? (["speechPostProcessingOpenAIReasoning"] as const) : []),
        ...(provider === "anthropic" ? (["speechPostProcessingAnthropicReasoning"] as const) : []),
      ]}
      title={`${label} cleanup`}
      description={
        provider === "compatible"
          ? "Sends text to your Chat Completions endpoint. The API key is optional for servers that do not require one."
          : `Sends text directly to ${label} without starting an agent. Each endpoint keeps its own key and model.`
      }
    >
      <div className="grid gap-3 py-3">
        {config && (
          <div className="grid gap-1.5">
            <span className="text-sm">API base URL</span>
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
          </div>
        )}
        <div className="grid gap-1.5">
          <span className="text-sm">Model ID</span>
          <Input
            key={model}
            disabled={!canManage}
            aria-label={`${label} cleanup model`}
            defaultValue={model}
            placeholder="Enter a model ID or choose below"
            maxLength={200}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value) saveModel(value);
              else event.target.value = model;
            }}
          />
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Combobox
                items={models}
                value={models.find((entry) => entry.id === model) ?? null}
                itemToStringLabel={(entry) => entry.name}
                itemToStringValue={(entry) => entry.id}
                filter={(entry, query) => contains(entry.name, query) || contains(entry.id, query)}
                onValueChange={(entry) => {
                  if (entry) saveModel(entry.id);
                }}
                disabled={!canManage || models.length === 0}
              >
                <ComboboxInput
                  aria-label="Available cleanup models"
                  placeholder="Search available models"
                />
                <ComboboxPopup>
                  <ComboboxEmpty>No matching models.</ComboboxEmpty>
                  <ComboboxList>
                    {(entry) => (
                      <ComboboxItem key={entry.id} value={entry}>
                        {entry.name} · {entry.id}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!prepared || !canLoadModels || catalog.waiting}
              onClick={refresh}
            >
              {catalog.waiting ? "Loading…" : "Refresh models"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" role="status">
            {AsyncResult.isFailure(catalog)
              ? "Could not load models. Check the saved key and endpoint, or enter a model ID manually."
              : !configured && provider !== "compatible"
                ? "Save an API key to load available models."
                : models.length > 0
                  ? `${models.length} models available. You can also enter any model ID above.`
                  : "You can enter a model ID manually if this endpoint does not list models."}
          </p>
        </div>
        {(provider === "openai" || provider === "anthropic") && (
          <div className="grid gap-1.5">
            <span className="text-sm">Reasoning level</span>
            <Select
              value={reasoning ?? "default"}
              disabled={!canManage}
              onValueChange={(value) => {
                const effort =
                  value === "default"
                    ? null
                    : SpeechCleanupReasoning.literals.find((entry) => entry === value);
                if (effort !== undefined)
                  update(
                    provider === "openai"
                      ? { speechPostProcessingOpenAIReasoning: effort }
                      : { speechPostProcessingAnthropicReasoning: effort },
                  );
              }}
            >
              <SelectTrigger aria-label="Cleanup reasoning level">
                <SelectValue>{reasoning ?? "Provider default"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="default">Provider default</SelectItem>
                {levels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              Supported levels depend on the model. Provider default sends no reasoning override.
            </p>
          </div>
        )}
        <div className="grid gap-1.5">
          <span className="text-sm">API key</span>
          <SecretInput
            aria-label={`${label} cleanup API key`}
            disabled={!canManage || keyStatus === "saving"}
            configured={configured}
            placeholder={provider === "compatible" ? "API key (optional)" : "API key"}
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setKeyStatus("idle");
            }}
          />
          <p className="text-xs text-muted-foreground" role="status">
            {keyStatus === "saving"
              ? "Saving API key…"
              : keyStatus === "failed"
                ? configured
                  ? "Could not save the change. Your previously saved key is still in use."
                  : "API key was not saved. Try again."
                : key.trim()
                  ? "New key entered. Save it to use it."
                  : configured
                    ? `API key saved on ${environment?.label ?? "this environment"}.`
                    : "No API key saved for this endpoint."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!canManage || !key.trim() || keyStatus === "saving"}
            onClick={() => saveKey(key.trim())}
          >
            Save API key
          </Button>
          {configured && (
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage || keyStatus === "saving"}
              onClick={() => saveKey("")}
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
  const { environment, scope } = useSettingsScope();
  const legacyOpenRouter = settings.speechPostProcessingProvider === "openrouter";
  const provider = legacyOpenRouter ? "compatible" : settings.speechPostProcessingProvider;
  const preset = legacyOpenRouter ? "openrouter" : settings.speechPostProcessingCompatiblePreset;
  const hasOpenCode = Object.values(settings.providerInstances).some(
    (entry) => entry.driver === "opencode",
  );
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
              if (next)
                update({
                  speechPostProcessingProvider: next,
                  ...(legacyOpenRouter
                    ? { speechPostProcessingCompatiblePreset: "openrouter" }
                    : {}),
                });
            }}
          >
            <SelectTrigger size="sm" aria-label="Cleanup provider">
              <SelectValue>{LABELS[provider]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {SpeechPostProcessingProvider.literals
                .filter(
                  (value) =>
                    value !== "openrouter" &&
                    (value !== "opencode" || hasOpenCode || provider === "opencode"),
                )
                .map((value) => (
                  <SelectItem key={value} value={value}>
                    {LABELS[value]}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        }
      />
      {provider === "compatible" && (
        <SettingsRow
          serverScoped
          settingKeys={["speechPostProcessingCompatiblePreset"]}
          title="Compatible endpoint"
          description="OpenRouter and custom endpoints keep separate keys and models."
          control={
            <Select
              value={preset}
              disabled={!canManage}
              onValueChange={(value) => {
                if (value === "custom" || value === "openrouter")
                  update({
                    speechPostProcessingProvider: "compatible",
                    speechPostProcessingCompatiblePreset: value,
                  });
              }}
            >
              <SelectTrigger size="sm" aria-label="Compatible endpoint preset">
                <SelectValue>
                  {preset === "openrouter" ? "OpenRouter" : "Custom endpoint"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="custom">Custom endpoint</SelectItem>
                <SelectItem value="openrouter">OpenRouter</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      )}
      {provider !== "agent" && provider !== "opencode" && (
        <CleanupApiForm
          key={`${scope.kind}:${environment?.environmentId}:${provider}:${preset}`}
          provider={provider === "compatible" && preset === "openrouter" ? "openrouter" : provider}
        />
      )}
    </>
  );
}
