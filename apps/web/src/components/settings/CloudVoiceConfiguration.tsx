import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { cloudSpeechDisclosure } from "@t3tools/shared/speech";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import {
  getCloudSpeechKeys,
  getCloudSpeechModels,
  setCloudSpeechKey,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  CloudSpeechModelId,
  CLOUD_SPEECH_LABELS,
  CLOUD_SPEECH_PROVIDER_NAMES,
  isSecretReference,
  SpeechModelId,
  type CloudSpeechModel,
  type CloudSpeechProvider,
  type SecretProviderId,
  type SettingsSecretValue,
  type VoiceTranscriptionDestination,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";
import { Atom, AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import { isSecretsFeatureEnabled } from "../../env";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  inEnvironmentSpeechRuntime,
  runEnvironmentSpeech,
} from "../../speech/runEnvironmentSpeech";
import {
  chooseAudioDestination,
  pendingCloudAudioChoice,
  useAudioChoice,
} from "../../speech/voiceConsent";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SecretInput } from "./SecretInput";
import { SecretSourceSelect } from "./SecretSourceInput";

// Per dialog instance, not an Atom.family: key presence must be read fresh each time it opens.
function useCloudRead<A, E>(
  prepared: PreparedConnection | null,
  read: (prepared: PreparedConnection) => Effect.Effect<A, E, HttpClient.HttpClient>,
) {
  const make = (connection: PreparedConnection | null) => ({
    prepared: connection,
    atom: Atom.make(
      connection ? inEnvironmentSpeechRuntime(read(connection)) : Effect.succeed(null),
    ),
  });
  const [current, setCurrent] = useState(() => make(prepared));
  if (current.prepared !== prepared) setCurrent(make(prepared));
  return [useAtomValue(current.atom), useAtomRefresh(current.atom)] as const;
}
const isApiKey = Schema.is(CloudSpeechApiKey);
const isModelId = Schema.is(CloudSpeechModelId);
const isCustomModelId = Schema.is(SpeechModelId);
/** Mirror of the server check: https, or plain http only for loopback hosts. */
function isCustomEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.search || url.hash) return false;
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "[::1]" || host === "127.0.0.1" || host.endsWith(".localhost");
  return url.protocol === "https:" || (url.protocol === "http:" && loopback);
}
type CloudDestination = Extract<VoiceTranscriptionDestination, { kind: "cloud" }>;

function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  current,
}: {
  models: ReadonlyArray<CloudSpeechModel>;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  /** The grant's model, flagged when the catalog no longer lists it. */
  current: string | undefined;
}) {
  const { contains } = useComboboxFilter();
  const selected = models.find((model) => model.id === value) ?? null;
  const delisted = current !== undefined && !models.some((model) => model.id === current);
  return (
    <div className="grid gap-1">
      <Combobox
        items={models}
        itemToStringLabel={(model: CloudSpeechModel) => model.name}
        itemToStringValue={(model: CloudSpeechModel) => model.id}
        filter={(model: CloudSpeechModel, query) =>
          contains(model.name, query) || contains(model.id, query)
        }
        value={selected}
        onValueChange={(model) => onChange(model?.id ?? "")}
        autoHighlight
        disabled={disabled}
      >
        <ComboboxInput
          id="voice-cloud-model"
          aria-label="OpenRouter model"
          placeholder="Search transcription models"
          autoFocus
          size="sm"
        />
        <ComboboxPopup>
          <ComboboxEmpty>No transcription model matches.</ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {(model: CloudSpeechModel) => (
              <ComboboxItem key={model.id} value={model}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{model.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{model.id}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      {delisted ? (
        <p className="text-sm text-destructive" role="alert">
          OpenRouter no longer lists {current}. Dictation stays off until you choose another model.
        </p>
      ) : selected ? (
        <p className="truncate text-xs text-muted-foreground">{selected.id}</p>
      ) : null}
    </div>
  );
}

export function CloudVoiceConfiguration({
  environment,
  provider,
  active,
  close,
}: {
  environment: Pick<EnvironmentPresentation, "environmentId" | "label" | "serverConfig">;
  provider: CloudSpeechProvider;
  active: boolean;
  close: () => void;
}) {
  const id = environment.environmentId;
  const name = CLOUD_SPEECH_LABELS[provider];
  const company = CLOUD_SPEECH_PROVIDER_NAMES[provider];
  const routed = provider === "openrouter" || provider === "custom";
  const custom = provider === "custom";
  const formId = useId();
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canUse = useEnvironmentScope(id, AuthOrchestrationOperateScope);
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const [presence, refresh] = useCloudRead(canUse ? prepared : null, getCloudSpeechKeys);
  const [models, refreshModels] = useCloudRead(
    routed && canUse ? prepared : null,
    getCloudSpeechModels,
  );
  const choice = useAudioChoice();
  const grant = choice === "off" ? null : choice;
  const currentModel =
    active &&
    grant?.destination.kind === "cloud" &&
    (grant.destination.provider === "openrouter" || grant.destination.provider === "custom")
      ? grant.destination.model
      : undefined;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "custom speech endpoint update",
    reportFailure: false,
  });
  const savedEndpoint = environment.serverConfig?.settings?.cloudSpeechCustomBaseUrl ?? "";
  const [endpoint, setEndpoint] = useState(savedEndpoint);
  const endpointChanged = custom && endpoint.trim() !== savedEndpoint;
  const endpointReady = !custom || isCustomEndpoint(endpoint);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState(currentModel ?? "");
  const saved = AsyncResult.isSuccess(presence) ? presence.value?.[provider] : undefined;
  const existing = environment.serverConfig?.settings?.cloudSpeechCredentials?.[provider];
  const sources =
    isSecretsFeatureEnabled && environment.serverConfig?.secretReferences
      ? configuredSecretSources(environment.serverConfig.settings?.secretProviders ?? {})
      : [];
  const reference =
    isSecretReference(existing) && sources.some((s) => s.id === existing.provider)
      ? existing
      : null;
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(reference?.provider ?? null);
  const [draft, setDraft] = useState(reference?.reference ?? "");
  const source = sources.find((s) => s.id === sourceId);
  const credential =
    sourceId !== null
      ? source && secretRequestReference(source, draft)
      : isApiKey(draft.trim())
        ? draft.trim()
        : undefined;
  const keyChanged =
    credential !== undefined &&
    !(
      isSecretReference(credential) &&
      reference?.provider === credential.provider &&
      reference.reference === credential.reference
    );
  const connected = canUse && prepared !== null;
  // Fixed providers edit the key only when nothing is saved or the device already uses them.
  const editingKey = canManage && saved !== undefined && (routed || active || !saved);
  const listedModels = AsyncResult.isSuccess(models) ? (models.value?.models ?? null) : null;
  const customModelReady = isCustomModelId(model.trim());
  const modelChosen = custom
    ? customModelReady
    : isModelId(model) && (listedModels?.some((m) => m.id === model) ?? false);
  const keyReady = draft.trim() ? credential !== undefined : Boolean(saved);
  const modelChanged = model !== (currentModel ?? "");
  const destination = (): CloudDestination =>
    custom && customModelReady
      ? { kind: "cloud", provider: "custom", environmentId: id, model: model.trim() }
      : routed && isModelId(model)
      ? { kind: "cloud", provider: "openrouter", environmentId: id, model }
      : { kind: "cloud", provider: provider as "openai" | "xai", environmentId: id };
  const enable = () => chooseAudioDestination(destination());
  const canSubmit = routed
    ? modelChosen &&
      endpointReady &&
      keyReady &&
      (!active || modelChanged || keyChanged || endpointChanged)
    : credential !== undefined;

  const saveKey = async (value: SettingsSecretValue | null, thenEnable: boolean) => {
    if (!connected || !canManage || busy) return;
    setError("");
    setBusy(true);
    try {
      const commit = thenEnable ? pendingCloudAudioChoice(destination()) : null;
      await runEnvironmentSpeech(setCloudSpeechKey(prepared, provider, value));
      refresh();
      commit?.();
      close();
    } catch {
      setError("Couldn’t save this change. Check your connection and try again.");
    }
    setBusy(false);
  };
  const submit = async () => {
    if (!canSubmit || busy) return;
    const grantChanges = !active || modelChanged || endpointChanged;
    if (endpointChanged) {
      setError("");
      setBusy(true);
      try {
        const result = await updateSettings({
          environmentId: id,
          input: { patch: { cloudSpeechCustomBaseUrl: endpoint.trim() } },
        });
        setBusy(false);
        if (result._tag !== "Success") {
          setError("Couldn’t save the endpoint URL. Check your connection and try again.");
          return;
        }
      } catch {
        setBusy(false);
        setError("Couldn’t save the endpoint URL. Check your connection and try again.");
        return;
      }
    }
    if (credential !== undefined && (!routed || keyChanged))
      return void saveKey(credential, grantChanges);
    // Model-only changes never write to the environment.
    if (grantChanges) enable();
    close();
  };

  const keyField = (
    <>
      <Label htmlFor="voice-cloud-key">{routed && saved ? "Replace API key" : "API key"}</Label>
      <div className="flex min-w-0 items-start gap-2">
        {sources.length > 0 && (
          <SecretSourceSelect
            value={sourceId}
            sources={sources}
            label={`${company} API key`}
            disabled={busy}
            onValueChange={(next) => {
              setSourceId(next);
              setDraft("");
              setError("");
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          {sourceId !== null ? (
            <Input
              key={sourceId}
              id="voice-cloud-key"
              name="reference"
              aria-label={`${company} API key reference`}
              autoFocus={!routed}
              placeholder={source?.referencePlaceholder}
              value={draft}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <SecretInput
              id="voice-cloud-key"
              name="key"
              aria-label={`${company} API key`}
              autoFocus={!routed}
              placeholder="Enter API key"
              value={draft}
              configured={saved === true}
              disabled={busy}
              maxLength={4096}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {draft.trim() && !credential
          ? (source?.invalidReferenceMessage ?? "Enter an API key, not a URL or secret reference.")
          : active && !routed
            ? "Updating the key keeps dictation enabled."
            : routed && saved
              ? "Leave blank to keep the saved key."
              : `Anyone with dictation access to ${environment.label} can bill this key.`}
      </p>
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {remove
              ? `Remove the ${company} key?`
              : active
                ? routed
                  ? custom
                    ? "Manage custom dictation"
                    : "Manage OpenRouter dictation"
                  : `Manage ${company} key`
                : `Use ${name} for dictation?`}
          </DialogTitle>
          <DialogDescription>
            {remove
              ? `Everyone using ${name} for dictation on ${environment.label} will lose access.`
              : active && !routed
                ? `Anyone with dictation access to ${environment.label} can use this API key.`
                : cloudSpeechDisclosure(provider, environment.label, {
                    endpoint: custom ? (endpoint.trim() || savedEndpoint) : undefined,
                  })}
          </DialogDescription>
        </DialogHeader>
        {!remove && (
          <DialogPanel>
            {!connected ? (
              <p>Connect to {environment.label} with dictation access to continue.</p>
            ) : AsyncResult.isFailure(presence) && saved === undefined ? (
              <Button size="sm" variant="outline" onClick={refresh}>
                Retry loading API key
              </Button>
            ) : routed &&
              AsyncResult.isSuccess(presence) &&
              presence.value &&
              saved === undefined ? (
              <p>Update {environment.label} to use {name} dictation.</p>
            ) : saved === undefined ? (
              <p role="status">Checking for an API key…</p>
            ) : routed ? (
              <form
                id={formId}
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                {custom ? (
                  <>
                    <div className="grid gap-2">
                      <Label htmlFor="voice-cloud-endpoint">Endpoint URL</Label>
                      <Input
                        id="voice-cloud-endpoint"
                        aria-label="Endpoint base URL"
                        placeholder="https://example.com/v1"
                        value={endpoint}
                        disabled={busy}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setEndpoint(event.target.value)}
                      />
                      <p className="text-sm text-muted-foreground">
                        Base URL of an OpenAI-compatible server, including the version path. Audio
                        is sent to its /audio/transcriptions route. Plain http is only allowed for
                        localhost.
                      </p>
                      {endpoint.trim() && !endpointReady ? (
                        <p className="text-sm text-destructive" role="alert">
                          Enter an https URL, or plain http for localhost.
                        </p>
                      ) : null}
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="voice-cloud-model">Model</Label>
                      <Input
                        id="voice-cloud-model"
                        aria-label="Transcription model"
                        placeholder="whisper-1"
                        value={model}
                        disabled={busy}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setModel(event.target.value)}
                      />
                    </div>
                  </>
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="voice-cloud-model">Model</Label>
                    {listedModels ? (
                      <ModelPicker
                        models={listedModels}
                        value={model}
                        onChange={setModel}
                        disabled={busy}
                        current={currentModel}
                      />
                    ) : AsyncResult.isFailure(models) ? (
                      <Button size="sm" variant="outline" type="button" onClick={refreshModels}>
                        Retry loading models
                      </Button>
                    ) : (
                      <p role="status" className="text-sm text-muted-foreground">
                        Loading transcription models…
                      </p>
                    )}
                  </div>
                )}
                {editingKey ? (
                  <div className="grid gap-2">{keyField}</div>
                ) : !saved ? (
                  <p>Ask an administrator on {environment.label} to add an API key.</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Uses the API key saved on {environment.label}. This choice applies only to this
                    device.
                  </p>
                )}
              </form>
            ) : editingKey ? (
              <form
                id={formId}
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                {keyField}
              </form>
            ) : !saved ? (
              <p>Ask an administrator on {environment.label} to add an API key.</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                This choice applies only to this device. Choose Off to stop sharing.
              </p>
            )}
          </DialogPanel>
        )}
        {error && (
          <p className="px-6 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          {connected && canManage && saved && (active || routed) && !remove && (
            <div className="sm:mr-auto">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setRemove(true)}
              >
                Remove key…
              </Button>
            </div>
          )}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {connected &&
            (remove ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void saveKey(null, false)}
              >
                Remove key
              </Button>
            ) : routed ? (
              saved !== undefined && (saved || canManage) ? (
                <Button type="submit" form={formId} size="sm" disabled={busy || !canSubmit}>
                  {active ? "Save" : "Save and enable"}
                </Button>
              ) : null
            ) : editingKey ? (
              <Button type="submit" form={formId} size="sm" disabled={busy || !credential}>
                {active ? "Save key" : "Save and enable"}
              </Button>
            ) : saved && !active ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  enable();
                  close();
                }}
              >
                Use {name}
              </Button>
            ) : null)}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
