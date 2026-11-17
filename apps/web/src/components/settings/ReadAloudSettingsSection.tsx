import { useEffect, useState, useSyncExternalStore } from "react";
import * as Option from "effect/Option";
import {
  cancelSpeechSynthesisModelDownload,
  downloadSpeechSynthesisModel,
  getCloudSpeechKeys,
  getSpeechSynthesisModels,
  linkSpeechSynthesisModels,
  removeSpeechSynthesisModel,
  setCloudSpeechKey,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  AuthFilesystemReadScope,
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
import { CheckIcon, DownloadIcon, StarIcon, XIcon } from "lucide-react";
import { Badge } from "../ui/badge";
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

const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

function LocalSpeechModel({
  prepared,
  model,
  selected,
  recommended,
  refreshing,
  onSelect,
  onChanged,
}: {
  prepared: PreparedConnection;
  model: SpeechSynthesisCatalog["models"][number];
  selected: boolean;
  recommended: boolean;
  /** A catalog request is in flight; polling waits for it rather than aborting it. */
  refreshing: boolean;
  onSelect: () => void;
  onChanged: () => void;
}) {
  const canManage = useEnvironmentScope(prepared.environmentId, AuthSettingsWriteScope);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState("");
  const install = model.install;
  const downloading = install?.state === "downloading" || install?.state === "verifying";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Poll the environment's download progress while it runs.
  useEffect(() => {
    if ((!downloading && !requesting) || refreshing) return;
    const timer = window.setTimeout(onChanged, 1_000);
    return () => window.clearTimeout(timer);
  }, [downloading, requesting, refreshing, onChanged]);
  if (!install) return null;
  const run = async (action: "download" | "cancel" | "remove") => {
    setRequesting(true);
    setError("");
    try {
      await runEnvironmentSpeech(
        action === "download"
          ? downloadSpeechSynthesisModel(prepared, model.id)
          : action === "cancel"
            ? cancelSpeechSynthesisModelDownload(prepared, model.id)
            : removeSpeechSynthesisModel(prepared, model.id),
      );
      if (action === "download") onSelect();
    } catch {
      setError(
        action === "download"
          ? "Could not download the model. Check the environment's connection and disk space."
          : "Could not change the model. Try again.",
      );
    }
    setRequesting(false);
    onChanged();
  };
  const progress =
    install.downloaded === undefined || install.size === 0
      ? 0
      : Math.min(100, (install.downloaded / install.size) * 100);
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          {model.name}
          {recommended && (
            <Badge variant="outline">
              <StarIcon className="mr-1 size-3" />
              Recommended
            </Badge>
          )}
        </span>
      }
      description={
        <>
          {model.description}{" "}
          {install.state === "installed"
            ? `Installed on the selected environment (${formatSize(install.size)}).`
            : `${formatSize(install.size)} download.`}
          {install.linkedFrom && (
            <span className="mt-0.5 block break-all text-2xs">
              Using your file at {install.linkedFrom}
            </span>
          )}
          {downloading && (
            <span className="mt-2 block">
              <span
                role="progressbar"
                aria-label={`${model.name} download progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
                className="block h-1 overflow-hidden rounded-full bg-muted"
              >
                <span
                  className="block h-full bg-primary transition-[width] duration-200"
                  style={{ width: `${progress}%` }}
                />
              </span>
              <span className="mt-1 block text-2xs">
                {install.state === "verifying"
                  ? "Verifying download…"
                  : `${Math.round(progress)}% downloaded`}
              </span>
            </span>
          )}
          {error && <span role="alert"> {error}</span>}
        </>
      }
      control={
        downloading ? (
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`Cancel ${model.name} download`}
            disabled={!canManage}
            onClick={() => void run("cancel")}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : install.state === "installed" ? (
          <div className="flex items-center gap-1.5">
            {selected ? (
              <Button size="sm" variant="secondary" disabled>
                <CheckIcon />
                Selected
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onSelect}>
                Use model
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage || requesting}
              aria-label={
                install.linkedFrom
                  ? `Stop using your ${model.name} file; the file stays on disk`
                  : `Remove ${model.name}`
              }
              onClick={() => void run("remove")}
            >
              {install.linkedFrom ? "Stop using" : "Remove"}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!canManage || requesting}
            onClick={() => void run("download")}
          >
            <DownloadIcon />
            Download
          </Button>
        )
      }
    />
  );
}

/** Links model files already on the environment instead of downloading them. */
function LocalSpeechModelLink({
  prepared,
  onChanged,
}: {
  prepared: PreparedConnection;
  onChanged: () => void;
}) {
  const canManage = useEnvironmentScope(prepared.environmentId, AuthSettingsWriteScope);
  const canReadFiles = useEnvironmentScope(prepared.environmentId, AuthFilesystemReadScope);
  const [path, setPath] = useState("");
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState("");
  if (!canManage || !canReadFiles) return null;
  return (
    <SettingsRow
      title="Use existing"
      description={
        <>
          Already downloaded one of these models elsewhere on this environment? Paste the file or
          folder path to use it in place.
          {error && <span role="alert"> {error}</span>}
        </>
      }
    >
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setLinking(true);
          setError("");
          void runEnvironmentSpeech(linkSpeechSynthesisModels(prepared, path))
            .then(
              () => setPath(""),
              () => setError("No speech model file was found at that path."),
            )
            .finally(() => {
              setLinking(false);
              onChanged();
            });
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            size="compact"
            aria-label="Path to a speech model file or folder already on this environment"
            placeholder="Model file or folder path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={linking || !path.trim()}>
          Use existing
        </Button>
      </form>
    </SettingsRow>
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
  const localModels =
    settings.provider === "local" ? catalog.models.filter((entry) => entry.install) : [];
  const refreshCatalog = () => setCatalogVersion((value) => value + 1);
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
  const modelEntry = catalog.models.find((entry) => entry.id === model);
  const voices =
    settings.provider === "system"
      ? systemVoices.map((voice) => ({ id: voice.voiceURI, name: voice.name }))
      : (modelEntry?.voices ?? []).map((voice) => ({
          id: voice,
          name: modelEntry?.voiceNames?.[voice] ?? voice,
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
          description="Read completed replies with the play button beside Copy. Hosted providers receive the response text through the selected environment; a local model runs on it."
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
                    <SelectGroupLabel>Via {environment.label}</SelectGroupLabel>
                    {(["local", "openai", "xai", "openrouter", "elevenlabs"] as const).map(
                      (provider) => (
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
                      ),
                    )}
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
          {prepared &&
            localModels.map((entry) => (
              <LocalSpeechModel
                key={`${prepared.environmentId}:${entry.id}`}
                prepared={prepared}
                model={entry}
                selected={entry.id === model}
                recommended={entry.id === catalog.defaultModel}
                refreshing={catalogState.version !== catalogVersion}
                onSelect={() => change({ model: entry.id, voice: "" })}
                onChanged={refreshCatalog}
              />
            ))}
          {prepared && localModels.some((entry) => entry.install?.state === "downloadable") && (
            <LocalSpeechModelLink prepared={prepared} onChanged={refreshCatalog} />
          )}
          {remote && error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {remote && !localModels.length && catalog.supportsModelSelection && (
            <SettingsRow
              title="Speech model"
              description="Choose a speech model from the provider catalog."
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
              description="An empty value uses the provider's default voice."
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
