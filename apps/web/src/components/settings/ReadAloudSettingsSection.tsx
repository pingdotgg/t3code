import { useEffect, useState, useSyncExternalStore } from "react";
import { T, useGT, useLocale, Var } from "gt-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  cancelSpeechSynthesisModelDownload,
  downloadSpeechSynthesisModel,
  getCloudSpeechKeys,
  getSpeechSynthesisModels,
  linkSpeechSynthesisModels,
  removeSpeechSynthesisModel,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { readAloudWordAlignment } from "@t3tools/client-runtime/read-aloud";
import {
  CloudSpeechSynthesisProvider,
  AuthFilesystemReadScope,
  AuthSettingsWriteScope,
  CLOUD_SPEECH_PROVIDER_NAMES,
  READ_ALOUD_LABELS,
  type EnvironmentId,
  EMPTY_SPEECH_SYNTHESIS_CATALOG,
  type ReadAloudSettings,
  type SpeechSynthesisCatalog,
  type SpeechSynthesisProvider,
} from "@t3tools/contracts";
import {
  getClientSettings,
  useClientSettings,
  updateClientSettings,
} from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { readAloudController } from "../../speech/readAloud";
import {
  CheckIcon,
  DownloadIcon,
  KeyRoundIcon,
  MonitorIcon,
  StarIcon,
  Trash2Icon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCloudRead } from "./CloudVoiceConfiguration";
import { CatalogCombobox } from "./CatalogCombobox";
import { ModelCatalogToolbar } from "./ModelCatalogToolbar";
import { orderSpeechLanguages } from "./SpeechModelComparison";
import { languageLabel } from "./SpeechLanguageSelect";
import { preferredSpeechLanguages } from "../../speech/preferredSpeechLanguages";
import { ReadAloudKeyDialog } from "./ReadAloudKeyDialog";
import { SpeechProviderIcon } from "./SpeechProviderIcon";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

function LocalSpeechModel({
  prepared,
  model,
  selected,
  recommended,
  refreshing,
  onSelect,
  onDownloaded,
  onChanged,
}: {
  prepared: PreparedConnection;
  model: SpeechSynthesisCatalog["models"][number];
  selected: boolean;
  recommended: boolean;
  /** A catalog request is in flight; polling waits for it rather than aborting it. */
  refreshing: boolean;
  onSelect: () => void;
  onDownloaded: () => void;
  onChanged: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const languages = model.languages ?? [];
  const canManage = useEnvironmentScope(prepared.environmentId, AuthSettingsWriteScope);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState("");
  const install = model.install;
  const downloading = install?.state === "downloading" || install?.state === "verifying";
  const removeLabel = install?.linkedFrom
    ? gt("Stop using your {name} file; the file stays on disk", { name: model.name })
    : gt("Delete {name}", { name: model.name });
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
      const catalog = await runEnvironmentSpeech(
        action === "download"
          ? downloadSpeechSynthesisModel(prepared, model.id)
          : action === "cancel"
            ? cancelSpeechSynthesisModelDownload(prepared, model.id)
            : removeSpeechSynthesisModel(prepared, model.id),
      );
      // A cancelled download also resolves, with the model still downloadable.
      const installed = catalog.models.find((entry) => entry.id === model.id)?.install?.state;
      if (action === "download" && installed === "installed") onDownloaded();
    } catch {
      setError(
        action === "download"
          ? gt("Could not download the model. Check the environment’s connection and disk space.")
          : gt("Could not change the model. Try again."),
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
    <div className="px-3 py-3">
      <div className="flex flex-col gap-2.5 @min-[28rem]/voice-models:flex-row @min-[28rem]/voice-models:items-start @min-[28rem]/voice-models:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium leading-5">{model.name}</span>
            {recommended && (
              <Badge variant="outline">
                <StarIcon className="mr-1 size-3" />
                {gt("Recommended")}
              </Badge>
            )}
          </div>
          {model.description ? (
            <p className="mt-0.5 text-xs leading-normal text-muted-foreground">
              {model.description}
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
            {languages.length > 1 ? (
              <span>
                {gt("{count, plural, one {{count} language} other {{count} languages}}", {
                  count: languages.length,
                })}
              </span>
            ) : languages[0] ? (
              <span>{languageLabel(languages[0], locale)}</span>
            ) : null}
            <span>{formatSize(install.size)}</span>
          </div>
          {install.linkedFrom && (
            <p className="mt-0.5 break-all text-2xs text-muted-foreground">
              <T>
                Using your file at <Var>{install.linkedFrom}</Var>
              </T>
            </p>
          )}
          {downloading && (
            <div className="mt-2">
              <div
                role="progressbar"
                aria-label={gt("{name} download progress", { name: model.name })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
                className="h-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-1 text-2xs text-muted-foreground">
                {install.state === "verifying"
                  ? gt("Verifying download…")
                  : gt("{percent}% downloaded", { percent: Math.round(progress) })}
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
          {downloading ? (
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={gt("Cancel {name} download", { name: model.name })}
              disabled={!canManage}
              onClick={() => void run("cancel")}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : install.state === "downloadable" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage || requesting}
              onClick={() => void run("download")}
            >
              <DownloadIcon />
              <T>Download</T>
            </Button>
          ) : selected ? (
            <Button size="sm" variant="secondary" disabled>
              <CheckIcon />
              <T>Selected</T>
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onSelect}>
              <T>Use model</T>
            </Button>
          )}
          {install.state === "installed" && (
            <SharedTooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="outline"
                  disabled={!canManage || requesting}
                  aria-label={removeLabel}
                  onClick={() => void run("remove")}
                />
              }
              label={removeLabel}
            >
              {install.linkedFrom ? <UnplugIcon /> : <Trash2Icon />}
            </SharedTooltipTrigger>
          )}
        </div>
      </div>
    </div>
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
  const gt = useGT();
  const canManage = useEnvironmentScope(prepared.environmentId, AuthSettingsWriteScope);
  const canReadFiles = useEnvironmentScope(prepared.environmentId, AuthFilesystemReadScope);
  const [path, setPath] = useState("");
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState("");
  if (!canManage || !canReadFiles) return null;
  return (
    <form
      className="mb-2 flex flex-col items-start gap-2 @min-[28rem]/voice-models:flex-row @min-[28rem]/voice-models:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        setLinking(true);
        setError("");
        void runEnvironmentSpeech(linkSpeechSynthesisModels(prepared, path))
          .then(
            () => setPath(""),
            () => setError(gt("No speech model file was found at that path.")),
          )
          .finally(() => {
            setLinking(false);
            onChanged();
          });
      }}
    >
      <div className="w-full min-w-0 flex-1">
        <Input
          size="compact"
          aria-label={gt("Path to a model file or folder already on this environment")}
          placeholder={gt("Already downloaded elsewhere? Paste the model file or folder path")}
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        {error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={linking || !path.trim()}>
        <T>Use existing</T>
      </Button>
    </form>
  );
}

type LocalModelSort = "recommended" | "size";
type LocalModelEntry = SpeechSynthesisCatalog["models"][number];

/** Read aloud's local models, browsed like transcription models: by name, language, and size. */
function LocalSpeechModelBrowser({
  prepared,
  models,
  selectedModel,
  refreshing,
  onSelect,
  onChanged,
}: {
  prepared: PreparedConnection;
  models: ReadonlyArray<LocalModelEntry>;
  selectedModel: string;
  refreshing: boolean;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LocalModelSort>("recommended");
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [preferred] = useState(preferredSpeechLanguages);
  const spoken = [...new Set(models.flatMap((entry) => entry.languages ?? []))];
  const defaultLanguage = preferred.find((code) => spoken.includes(code));
  const selectedLanguages = selection ?? (defaultLanguage ? [defaultLanguage] : []);
  const query = search.trim().toLocaleLowerCase();
  const order = (entry: LocalModelEntry) =>
    entry.id === selectedModel
      ? 0
      : entry.install?.state === "installed"
        ? 1
        : entry.install?.state === "downloading" || entry.install?.state === "verifying"
          ? 2
          : 3;
  const shown = models
    .filter(
      (entry) =>
        selectedLanguages.every((code) => entry.languages?.includes(code) ?? true) &&
        (!downloadedOnly || entry.install?.state === "installed") &&
        (!query || `${entry.name} ${entry.description ?? ""}`.toLocaleLowerCase().includes(query)),
    )
    .toSorted((left, right) =>
      sort === "size"
        ? (left.install?.size ?? 0) - (right.install?.size ?? 0)
        : order(left) - order(right) ||
          Number(right.recommended === true) - Number(left.recommended === true),
    );
  const selected = models.find((entry) => entry.id === selectedModel);
  const rendered = selected && !shown.includes(selected) ? [selected, ...shown] : shown;
  const sortLabels: Record<LocalModelSort, string> = {
    recommended: gt("Recommended"),
    size: gt("Smallest"),
  };
  return (
    <SettingsRow
      title={gt("Models")}
      description={gt(
        "Downloaded once to the selected environment, which reads replies without the text leaving it.",
      )}
      className="@container/voice-models"
    >
      <ModelCatalogToolbar
        searchLabel={gt("Search speech models")}
        search={search}
        onSearch={setSearch}
        languages={orderSpeechLanguages(spoken, preferred, locale)}
        selectedLanguages={selectedLanguages}
        onSelectLanguages={setSelection}
        sort={sort}
        sortLabels={sortLabels}
        onSort={setSort}
        downloadedOnly={downloadedOnly}
        onDownloadedOnly={setDownloadedOnly}
      />
      <div
        className="mt-2 mb-2 max-h-96 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60"
        role="region"
        aria-label={gt("Read-aloud models")}
        tabIndex={0}
      >
        {shown.length === 0 && (
          <p className="px-3 py-3 text-sm text-muted-foreground">
            <T>No models match.</T>
          </p>
        )}
        {rendered.map((entry) => (
          <LocalSpeechModel
            key={`${prepared.environmentId}:${entry.id}`}
            prepared={prepared}
            model={entry}
            selected={entry.id === selectedModel}
            recommended={entry.recommended === true}
            refreshing={refreshing}
            onSelect={() => onSelect(entry.id)}
            onDownloaded={() => {
              // Settings may have moved on while the model downloaded.
              const current = getClientSettings().readAloud;
              if (current.provider === "local" && current.environmentId === prepared.environmentId)
                void updateClientSettings({
                  readAloud: { ...current, model: entry.id, voice: "" },
                });
            }}
            onChanged={onChanged}
          />
        ))}
      </div>
      <LocalSpeechModelLink prepared={prepared} onChanged={onChanged} />
    </SettingsRow>
  );
}

export function ReadAloudSettingsSection() {
  const gt = useGT();
  const settings = useClientSettings((value) => value.readAloud);
  const { environments } = useEnvironments();

  const prepared = Option.getOrNull(usePreparedConnection(settings.environmentId));
  const [catalogVersion, setCatalogVersion] = useState(0);
  // A hosted provider is confirmed in its key dialog before read aloud switches to it.
  const [pendingCloud, setPendingCloud] = useState<{
    readonly provider: CloudSpeechSynthesisProvider;
    readonly environmentId: EnvironmentId;
  } | null>(null);
  const catalogKey = JSON.stringify([settings.environmentId, settings.provider]);
  const [catalogState, setCatalogState] = useState<{
    key: string;
    version: number;
    catalog: SpeechSynthesisCatalog;
    failed: boolean;
  }>({ key: "", version: -1, catalog: EMPTY_SPEECH_SYNTHESIS_CATALOG, failed: false });
  const catalog =
    catalogState.key === catalogKey ? catalogState.catalog : EMPTY_SPEECH_SYNTHESIS_CATALOG;
  const error =
    catalogState.key === catalogKey && catalogState.version === catalogVersion
      ? catalogState.failed
        ? gt(
            "Could not load speech models. Check the selected environment and provider configuration.",
          )
        : catalog.error || ""
      : "";
  const model = settings.model || catalog.defaultModel;
  const localModels =
    settings.provider === "local" ? catalog.models.filter((entry) => entry.install) : [];
  const refreshCatalog = () => setCatalogVersion((value) => value + 1);
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The preview belongs to this page, so closing settings stops it.
  useEffect(
    () => () => {
      if (readAloudController.getSnapshot().id === "read-aloud-preview") readAloudController.stop();
    },
    [],
  );
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  const remote = settings.provider !== "off" && settings.provider !== "system";
  const locale = useLocale();
  const alignment = readAloudWordAlignment(settings, locale);
  const englishLocale = /^en(?:-|$)/i.test(locale);
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
      getSpeechSynthesisModels(prepared, settings.provider as SpeechSynthesisProvider, alignment),
      { signal: abort.signal },
    ).then(
      (result) => {
        if (!abort.signal.aborted)
          setCatalogState({
            key: catalogKey,
            version: catalogVersion,
            catalog: result,
            failed: false,
          });
      },
      () => {
        if (!abort.signal.aborted)
          setCatalogState({
            key: catalogKey,
            version: catalogVersion,
            catalog: EMPTY_SPEECH_SYNTHESIS_CATALOG,
            failed: true,
          });
      },
    );
    return () => abort.abort();
  }, [prepared, remote, settings.provider, catalogKey, catalogVersion, alignment]);
  const modelEntry = catalog.models.find((entry) => entry.id === model);
  const voices =
    settings.provider === "system"
      ? systemVoices.map((voice) => ({ id: voice.voiceURI, name: voice.name }))
      : (modelEntry?.voices ?? []).map((voice) => ({
          id: voice,
          name: modelEntry?.voiceNames?.[voice] ?? voice,
        }));
  const source = remote ? `${settings.provider}:${settings.environmentId}` : settings.provider;
  const cloudProvider =
    remote && settings.provider !== "local"
      ? (settings.provider as CloudSpeechSynthesisProvider)
      : null;
  const [keys] = useCloudRead(cloudProvider ? prepared : null, getCloudSpeechKeys);
  const keyMissing =
    cloudProvider !== null && AsyncResult.isSuccess(keys) && keys.value?.[cloudProvider] === false;
  const pendingEnvironment = environments.find(
    (entry) => entry.environmentId === pendingCloud?.environmentId,
  );
  const selectedEnvironment = environments.find(
    (entry) => entry.environmentId === settings.environmentId,
  );
  return (
    <SettingsSection id="read-aloud-section" title={gt("Read aloud")}>
      <SettingsSearchTarget id="read-aloud">
        <SettingsRow
          title={gt("Speech provider")}
          description={
            keyMissing && cloudProvider ? (
              <span className="text-destructive">
                {selectedEnvironment
                  ? gt("{environment} has no {company} API key. Add one with the key button.", {
                      environment: selectedEnvironment.label,
                      company: CLOUD_SPEECH_PROVIDER_NAMES[cloudProvider],
                    })
                  : gt("This environment has no {company} API key. Add one with the key button.", {
                      company: CLOUD_SPEECH_PROVIDER_NAMES[cloudProvider],
                    })}
              </span>
            ) : remote && error ? (
              <span className="text-destructive">{error}</span>
            ) : (
              gt(
                "Read completed replies with the play button beside Copy. Hosted providers receive the response text through the selected environment; a local model runs on it.",
              )
            )
          }
          control={
            <div className="flex min-w-0 items-center gap-1.5">
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
                    if (provider === "local")
                      change({
                        provider: "local",
                        environmentId: environment.environmentId,
                        model: "",
                        voice: "",
                      });
                    else
                      setPendingCloud({
                        provider: provider as CloudSpeechSynthesisProvider,
                        environmentId: environment.environmentId,
                      });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={gt("Read-aloud provider")}
                  className="w-auto min-w-0 max-w-72"
                >
                  <SelectValue>
                    <span className="flex min-w-0 items-center gap-2">
                      {settings.provider === "local" ? (
                        <MonitorIcon aria-hidden className="size-4" />
                      ) : (
                        <SpeechProviderIcon provider={settings.provider} />
                      )}
                      <span className="truncate">
                        {settings.provider === "local" ? (
                          (selectedEnvironment?.label ?? gt("Chosen environment (unavailable)"))
                        ) : remote ? (
                          // The environment is muted, as in the transcription picker.
                          <T>
                            <Var>{READ_ALOUD_LABELS[settings.provider]}</Var>{" "}
                            <span className="text-muted-foreground">
                              via{" "}
                              <Var>
                                {selectedEnvironment?.label ?? gt("unavailable environment")}
                              </Var>
                            </span>
                          </T>
                        ) : settings.provider === "system" ? (
                          gt("System voices")
                        ) : (
                          gt("Off", { $context: "read aloud disabled" })
                        )}
                      </span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="off">
                    <span className="flex items-center gap-2">
                      <SpeechProviderIcon provider="off" />
                      {gt("Off", { $context: "read aloud disabled" })}
                    </span>
                  </SelectItem>
                  <SelectGroup>
                    <SelectGroupLabel>
                      <T>On this device</T>
                    </SelectGroupLabel>
                    <SelectItem value="system">
                      <span className="flex items-center gap-2">
                        <SpeechProviderIcon provider="system" />
                        {gt("System voices")}
                      </span>
                    </SelectItem>
                  </SelectGroup>
                  {environments.length > 0 && (
                    <SelectGroup>
                      <SelectGroupLabel>
                        <T>On an environment</T>
                      </SelectGroupLabel>
                      {environments.map((environment) => (
                        <SelectItem
                          key={environment.environmentId}
                          value={`local:${environment.environmentId}`}
                        >
                          <span className="flex items-center gap-2">
                            <MonitorIcon aria-hidden className="size-4" />
                            {environment.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {environments.map((environment) => (
                    <SelectGroup key={environment.environmentId}>
                      <SelectGroupLabel>
                        <T>
                          Cloud via <Var>{environment.label}</Var>
                        </T>
                      </SelectGroupLabel>
                      {CloudSpeechSynthesisProvider.literals.map((provider) => (
                        <SelectItem
                          key={provider}
                          value={`${provider}:${environment.environmentId}`}
                          aria-label={gt("{provider} via {environment}", {
                            provider: READ_ALOUD_LABELS[provider],
                            environment: environment.label,
                          })}
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
                    <SelectItem value={source}>{gt("Chosen environment (unavailable)")}</SelectItem>
                  )}
                </SelectPopup>
              </Select>
              {cloudProvider && selectedEnvironment && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                        aria-label={gt("Manage read-aloud key")}
                        onClick={() =>
                          setPendingCloud({
                            provider: cloudProvider,
                            environmentId: selectedEnvironment.environmentId,
                          })
                        }
                      >
                        <KeyRoundIcon aria-hidden className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipPopup>
                    <T>Manage key</T>
                  </TooltipPopup>
                </Tooltip>
              )}
            </div>
          }
        />
      </SettingsSearchTarget>
      {pendingCloud && pendingEnvironment && (
        <ReadAloudKeyDialog
          key={`${pendingCloud.environmentId}:${pendingCloud.provider}`}
          environment={pendingEnvironment}
          provider={pendingCloud.provider}
          active={
            settings.provider === pendingCloud.provider &&
            settings.environmentId === pendingCloud.environmentId
          }
          onEnable={() =>
            change({
              provider: pendingCloud.provider,
              environmentId: pendingCloud.environmentId,
              model: "",
              voice: "",
            })
          }
          close={() => {
            setPendingCloud(null);
            refreshCatalog();
          }}
        />
      )}
      {settings.provider === "off" ? null : (
        <>
          {prepared && localModels.length > 0 && (
            <LocalSpeechModelBrowser
              prepared={prepared}
              models={localModels}
              selectedModel={model}
              refreshing={catalogState.version !== catalogVersion}
              onSelect={(id) => change({ model: id, voice: "" })}
              onChanged={refreshCatalog}
            />
          )}
          {cloudProvider && catalog.supportsModelSelection && catalog.models.length > 0 && (
            <SettingsRow
              title={gt("Model", { $context: "text-to-speech model setting" })}
              description={gt("The {company} model that reads replies aloud.", {
                company: CLOUD_SPEECH_PROVIDER_NAMES[cloudProvider],
              })}
              control={
                <div className="w-64 max-w-full">
                  <CatalogCombobox
                    items={catalog.models}
                    value={model}
                    onChange={(next) => {
                      if (next && next !== model) change({ model: next, voice: "" });
                    }}
                    label={gt("Read-aloud model")}
                    placeholder={gt("Search speech models")}
                    empty={<T>No speech model matches.</T>}
                  />
                </div>
              }
            />
          )}
          {(settings.provider === "system" ||
            (catalog.supportsVoiceSelection && catalog.models.length > 0)) && (
            <SettingsRow
              title={gt("Voice", { $context: "the speaker voice used to read text aloud" })}
              description={gt("An empty value uses the provider’s default voice.")}
              control={
                <div className="w-64 max-w-full">
                  {voices.length ? (
                    <CatalogCombobox
                      items={[
                        { id: "", name: gt("Default", { $context: "default voice" }) },
                        ...voices,
                      ]}
                      value={settings.voice}
                      onChange={(voice) => {
                        if (voice !== settings.voice) change({ voice });
                      }}
                      label={gt("Read-aloud voice")}
                      placeholder={gt("Search voices")}
                      empty={<T>No voice matches.</T>}
                      showIds={false}
                    />
                  ) : (
                    <Input
                      aria-label={gt("Read-aloud voice")}
                      placeholder={gt("Default voice")}
                      value={settings.voice}
                      onChange={(event) => change({ voice: event.target.value })}
                    />
                  )}
                </div>
              }
            />
          )}
          <SettingsRow
            title={gt("Speed")}
            description={gt("Playback speed.")}
            control={
              <Select
                value={String(settings.speed)}
                onValueChange={(value) => {
                  if (value) change({ speed: Number(value) });
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Read-aloud speed")}>
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
            title={gt("Skip code blocks")}
            description={gt(
              "Read the prose and inline identifiers without narrating fenced code blocks.",
            )}
            control={
              <Switch
                aria-label={gt("Skip code blocks when reading")}
                checked={settings.skipCodeBlocks}
                onCheckedChange={(skipCodeBlocks) => change({ skipCodeBlocks })}
              />
            }
          />
          {remote && englishLocale && catalog.wordTimings !== "provider" ? (
            <SettingsRow
              title={gt("Multilingual word timing")}
              description={gt(
                "Highlight the spoken word in 25 languages, not just English. Downloads a 740 MB model to the selected environment instead of a 135 MB one.",
              )}
              control={
                <Switch
                  aria-label={gt("Time words in 25 languages")}
                  checked={settings.multilingualWordTiming}
                  onCheckedChange={(multilingualWordTiming) => change({ multilingualWordTiming })}
                />
              }
            />
          ) : null}
          <SettingsRow
            title={gt("Preview", { $context: "noun, a sample of the voice" })}
            description={
              state.id === "read-aloud-preview" && state.error
                ? state.error
                : gt("Play a short sample using the selected speech provider.")
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
                        gt("This is T3 Code. Your agent’s response is ready to read aloud."),
                        settings,
                      )
                }
              >
                {state.id === "read-aloud-preview" && state.status !== "error"
                  ? gt("Stop preview")
                  : gt("Play preview")}
              </Button>
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
