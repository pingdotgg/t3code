import { useEffect, useState, useSyncExternalStore } from "react";
import * as Option from "effect/Option";
import {
  getCloudSpeechKeys,
  getSpeechSynthesisModels,
  setCloudSpeechKey,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  AuthSettingsWriteScope,
  READ_ALOUD_LABELS,
  EMPTY_SPEECH_SYNTHESIS_CATALOG,
  type CloudSpeechProvider,
  type ReadAloudSettings,
  type SpeechSynthesisCatalog,
  type SpeechSynthesisProvider,
} from "@t3tools/contracts";
import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { readAloudController } from "../../speech/readAloud";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectGroupLabel,
} from "../ui/select";
import { SettingsRow, SettingsSearchTarget, SettingsSection } from "./settingsLayout";
import { SecretInput } from "./SecretInput";
import { SpeechProviderIcon } from "./SpeechProviderIcon";

function ReadAloudKey({
  prepared,
  provider,
  onSaved,
}: {
  prepared: PreparedConnection;
  provider: CloudSpeechProvider;
  onSaved: () => void;
}) {
  const canManage = useEnvironmentScope(prepared.environmentId, AuthSettingsWriteScope);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read credential presence from the selected environment without exposing its secret.
  useEffect(() => {
    const controller = new AbortController();
    void runEnvironmentSpeech(getCloudSpeechKeys(prepared), { signal: controller.signal }).then(
      (keys) => setConfigured(Boolean(keys[provider])),
      () => setConfigured(false),
    );
    return () => controller.abort();
  }, [prepared, provider]);
  const save = async (remove: boolean) => {
    setBusy(true);
    setError("");
    try {
      await runEnvironmentSpeech(
        setCloudSpeechKey(prepared, provider, remove ? null : draft.trim()),
      );
      setDraft("");
      setConfigured(!remove);
      onSaved();
    } catch {
      setError("Could not save the API key. Check your connection and permissions.");
    }
    setBusy(false);
  };
  return (
    <SettingsRow
      title="API key"
      description={
        <>
          {configured
            ? "Uses the key already saved for dictation on this environment."
            : "Stored on the selected environment and shared with dictation."}
          {error && <span role="alert"> {error}</span>}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          <SecretInput
            aria-label="Read-aloud API key"
            value={draft}
            configured={configured === true}
            disabled={!canManage || busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            size="sm"
            disabled={!canManage || busy || configured === null || !draft.trim()}
            onClick={() => void save(false)}
          >
            Save
          </Button>
          {configured && (
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage || busy}
              onClick={() => void save(true)}
            >
              Remove
            </Button>
          )}
        </div>
      }
    />
  );
}

export function ReadAloudSettingsSection() {
  const settings = useClientSettings((value) => value.readAloud);
  const { environments } = useEnvironments();

  const prepared = Option.getOrNull(usePreparedConnection(settings.environmentId));
  const [catalogVersion, setCatalogVersion] = useState(0);
  const catalogKey = JSON.stringify([settings.environmentId, settings.provider]);
  const [catalogState, setCatalogState] = useState<{
    key: string;
    version: number;
    catalog: SpeechSynthesisCatalog;
    error: string;
  }>({ key: "", version: -1, catalog: EMPTY_SPEECH_SYNTHESIS_CATALOG, error: "" });
  const catalog =
    catalogState.key === catalogKey ? catalogState.catalog : EMPTY_SPEECH_SYNTHESIS_CATALOG;
  const error =
    catalogState.key === catalogKey && catalogState.version === catalogVersion
      ? catalogState.error || catalog.error || ""
      : "";
  const model = settings.model || catalog.defaultModel;
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  const remote = settings.provider !== "off" && settings.provider !== "system";
  const change = (patch: Partial<ReadAloudSettings>) => {
    readAloudController.stop();
    void updateClientSettings({ readAloud: { ...settings, ...patch } });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The browser loads its installed voices asynchronously.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const refresh = () => setSystemVoices(speechSynthesis.getVoices());
    refresh();
    speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetch speech model and voice choices from the selected environment.
  useEffect(() => {
    if (!remote || !prepared) return;
    const abort = new AbortController();
    void runEnvironmentSpeech(
      getSpeechSynthesisModels(prepared, settings.provider as SpeechSynthesisProvider),
      { signal: abort.signal },
    ).then(
      (result) => {
        if (!abort.signal.aborted)
          setCatalogState({ key: catalogKey, version: catalogVersion, catalog: result, error: "" });
      },
      () => {
        if (!abort.signal.aborted)
          setCatalogState({
            key: catalogKey,
            version: catalogVersion,
            catalog: EMPTY_SPEECH_SYNTHESIS_CATALOG,
            error:
              "Could not load speech models. Check the selected environment and provider configuration.",
          });
      },
    );
    return () => abort.abort();
  }, [prepared, remote, settings.provider, catalogKey, catalogVersion]);
  const voices =
    settings.provider === "system"
      ? systemVoices.map((voice) => ({ id: voice.voiceURI, name: voice.name }))
      : (catalog.models.find((entry) => entry.id === model)?.voices ?? []).map((voice) => ({
          id: voice,
          name: voice,
        }));
  const source = remote ? `${settings.provider}:${settings.environmentId}` : settings.provider;
  const selectedEnvironment = environments.find(
    (entry) => entry.environmentId === settings.environmentId,
  );
  return (
    <SettingsSection id="read-aloud-section" title="Read aloud">
      <SettingsSearchTarget id="read-aloud">
        <SettingsRow
          title="Speech provider"
          description="Read completed replies with the play button beside Copy. Hosted providers receive the response text through the selected environment."
          control={
            <Select
              value={source}
              onValueChange={(value) => {
                if (!value) return;
                if (value === "off" || value === "system")
                  change({ provider: value, environmentId: null, model: "", voice: "" });
                else {
                  const [provider, ...rest] = value.split(":");
                  const environment = environments.find(
                    (entry) => entry.environmentId === rest.join(":"),
                  );
                  if (!environment) return;
                  change({
                    provider: provider as SpeechSynthesisProvider,
                    environmentId: environment.environmentId,
                    model: "",
                    voice: "",
                  });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Read-aloud provider"
                className="w-auto min-w-0 max-w-72"
              >
                <SelectValue>
                  <span className="flex min-w-0 items-center gap-2">
                    <SpeechProviderIcon provider={settings.provider} />
                    <span className="truncate">
                      {READ_ALOUD_LABELS[settings.provider]}
                      {remote && (
                        <span className="text-muted-foreground">
                          {" "}
                          via {selectedEnvironment?.label ?? "unavailable environment"}
                        </span>
                      )}
                    </span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="off">
                  <span className="flex items-center gap-2">
                    <SpeechProviderIcon provider="off" />
                    Off
                  </span>
                </SelectItem>
                <SelectGroup>
                  <SelectGroupLabel>On this device</SelectGroupLabel>
                  <SelectItem value="system">
                    <span className="flex items-center gap-2">
                      <SpeechProviderIcon provider="system" />
                      System voices
                    </span>
                  </SelectItem>
                </SelectGroup>
                {environments.map((environment) => (
                  <SelectGroup key={environment.environmentId}>
                    <SelectGroupLabel>Cloud via {environment.label}</SelectGroupLabel>
                    {(["openai", "xai", "openrouter"] as const).map((provider) => (
                      <SelectItem
                        key={provider}
                        value={`${provider}:${environment.environmentId}`}
                        aria-label={`${READ_ALOUD_LABELS[provider]} via ${environment.label}`}
                      >
                        <span className="flex items-center gap-2">
                          <SpeechProviderIcon provider={provider} />
                          {READ_ALOUD_LABELS[provider]}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
                {remote && !selectedEnvironment && (
                  <SelectItem value={source}>Chosen environment (unavailable)</SelectItem>
                )}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSearchTarget>
      {settings.provider === "off" ? null : (
        <>
          {remote && prepared && catalog.apiKeyProvider && (
            <ReadAloudKey
              key={`${prepared.environmentId}:${settings.provider}`}
              prepared={prepared}
              provider={catalog.apiKeyProvider}
              onSaved={() => setCatalogVersion((value) => value + 1)}
            />
          )}
          {remote && catalog.supportsModelSelection && (
            <SettingsRow
              title="Speech model"
              description={error || "Choose a speech model from the provider catalog."}
              control={
                <Select
                  value={model}
                  onValueChange={(value) => {
                    if (value) change({ model: value, voice: "" });
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Read-aloud model">
                    <SelectValue>
                      {catalog.models.find((entry) => entry.id === model)?.name ||
                        model ||
                        "Choose a model"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {catalog.models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          )}
          {(settings.provider === "system" || catalog.supportsVoiceSelection) && (
            <SettingsRow
              title="Voice"
              description="An empty value uses the first available OpenRouter voice or the provider's default."
              control={
                voices.length ? (
                  <Select
                    value={settings.voice || "default"}
                    onValueChange={(value) => {
                      if (value) change({ voice: value === "default" ? "" : value });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Read-aloud voice">
                      <SelectValue>
                        {voices.find((entry) => entry.id === settings.voice)?.name || "Default"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="default">Default</SelectItem>
                      {voices.map((voice) => (
                        <SelectItem key={voice.id} value={voice.id}>
                          {voice.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <Input
                    aria-label="Read-aloud voice"
                    placeholder="Default voice"
                    value={settings.voice}
                    onChange={(event) => change({ voice: event.target.value })}
                  />
                )
              }
            />
          )}
          <SettingsRow
            title="Speed"
            description="Playback speed."
            control={
              <Select
                value={String(settings.speed)}
                onValueChange={(value) => {
                  if (value) change({ speed: Number(value) });
                }}
              >
                <SelectTrigger size="sm" aria-label="Read-aloud speed">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {[0.75, 1, 1.25, 1.5].map((speed) => (
                    <SelectItem key={speed} value={String(speed)}>
                      {speed}×
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Skip code blocks"
            description="Read the prose and inline identifiers without narrating fenced code blocks."
            control={
              <Switch
                aria-label="Skip code blocks when reading"
                checked={settings.skipCodeBlocks}
                onCheckedChange={(skipCodeBlocks) => change({ skipCodeBlocks })}
              />
            }
          />
          <SettingsRow
            title="Preview"
            description={
              state.id === "read-aloud-preview" && state.error
                ? state.error
                : "Play a short sample using the selected speech provider."
            }
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  state.id === "read-aloud-preview" && state.status !== "error"
                    ? readAloudController.stop()
                    : void readAloudController.start(
                        "read-aloud-preview",
                        "This is T3 Code. Your agent's response is ready to read aloud.",
                        settings,
                      )
                }
              >
                {state.id === "read-aloud-preview" && state.status !== "error"
                  ? "Stop preview"
                  : "Play preview"}
              </Button>
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
