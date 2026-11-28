import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { cloudSpeechDisclosure } from "@t3tools/shared/speechCopy";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { hasFeatureFlag } from "@t3tools/client-runtime/state/server";
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
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL,
  CLOUD_SPEECH_LABELS,
  CLOUD_SPEECH_PROVIDER_NAMES,
  isSecretReference,
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
import { T, useGT, useMessages, Var } from "gt-react";
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
import { CatalogCombobox } from "./CatalogCombobox";
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
import { OpenRouterSignIn } from "./OpenRouterSignIn";
import { SecretInput } from "./SecretInput";
import { SecretSourceSelect } from "./SecretSourceInput";

// Per dialog instance, not an Atom.family: key presence must be read fresh each time it opens.
export function useCloudRead<A, E>(
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
type CloudDestination = Extract<VoiceTranscriptionDestination, { kind: "cloud" }>;

/** Chooses the OpenRouter model dictation transcribes with. */
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
  const gt = useGT();
  const selected = models.find((model) => model.id === value) ?? null;
  const delisted = current !== undefined && !models.some((model) => model.id === current);
  return (
    <div className="grid gap-1">
      <CatalogCombobox
        items={models}
        value={value}
        onChange={onChange}
        disabled={disabled}
        id="voice-cloud-model"
        label={gt("OpenRouter model")}
        placeholder={gt("Search transcription models")}
        empty={<T>No transcription model matches.</T>}
      />
      {delisted ? (
        <p className="text-sm text-destructive" role="alert">
          <T>
            OpenRouter no longer lists <Var>{current}</Var>. Dictation stays off until you choose
            another model.
          </T>
        </p>
      ) : selected ? (
        <p className="truncate text-xs text-muted-foreground">{selected.id}</p>
      ) : null}
    </div>
  );
}

/** The OpenRouter model dictation uses, chosen once OpenRouter is set up on the environment. */
export function OpenRouterDictationModel({
  environmentId,
  model,
}: {
  environmentId: EnvironmentPresentation["environmentId"];
  model: string;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canUse = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [models, reload] = useCloudRead(canUse ? prepared : null, getCloudSpeechModels);
  const listed = AsyncResult.isSuccess(models) ? (models.value?.models ?? null) : null;
  if (listed)
    return (
      <ModelPicker
        models={listed}
        value={model}
        current={model}
        disabled={false}
        onChange={(next) => {
          if (next && next !== model)
            chooseAudioDestination({
              kind: "cloud",
              provider: "openrouter",
              environmentId,
              model: next,
            });
        }}
      />
    );
  return AsyncResult.isFailure(models) ? (
    <Button size="sm" variant="outline" type="button" onClick={reload}>
      <T>Retry loading models</T>
    </Button>
  ) : (
    <p role="status" className="text-sm text-muted-foreground">
      <T>Loading transcription models…</T>
    </p>
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
  const gt = useGT();
  const messages = useMessages();
  const id = environment.environmentId;
  const name = CLOUD_SPEECH_LABELS[provider];
  const company = CLOUD_SPEECH_PROVIDER_NAMES[provider];
  const routed = provider === "openrouter";
  const formId = useId();
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canUse = useEnvironmentScope(id, AuthOrchestrationOperateScope);
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const canUseReferences = useEnvironmentScope(id, AuthProvidersManageScope);
  const [presence, refresh] = useCloudRead(canUse ? prepared : null, getCloudSpeechKeys);
  const choice = useAudioChoice();
  const grant = choice === "off" ? null : choice;
  const currentModel =
    active && grant?.destination.kind === "cloud" && grant.destination.provider === "openrouter"
      ? grant.destination.model
      : undefined;
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = AsyncResult.isSuccess(presence) ? presence.value?.[provider] : undefined;
  const existing = environment.serverConfig?.settings?.cloudSpeechCredentials?.[provider];
  const sources =
    canUseReferences &&
    hasFeatureFlag(environment.serverConfig, "secretProviders") &&
    environment.serverConfig?.secretReferences
      ? configuredSecretSources(environment.serverConfig.settings?.secretProviders ?? {}, messages)
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
  const keyReady = draft.trim() ? credential !== undefined : Boolean(saved);
  // The model is chosen in voice settings once OpenRouter is set up; it starts at the default.
  const destination = (): CloudDestination =>
    routed
      ? {
          kind: "cloud",
          provider: "openrouter",
          environmentId: id,
          model: currentModel ?? DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL,
        }
      : { kind: "cloud", provider: provider as "openai" | "xai", environmentId: id };
  const enable = () => chooseAudioDestination(destination());
  const canSubmit = routed ? keyReady && (!active || keyChanged) : credential !== undefined;

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
      setError(gt("Couldn’t save this change. Check your connection and try again."));
    }
    setBusy(false);
  };
  const submit = () => {
    if (!canSubmit || busy) return;
    if (credential !== undefined && (!routed || keyChanged))
      return void saveKey(credential, !active);
    if (!active) enable();
    close();
  };

  const keyField = (
    <>
      {routed && connected && (
        <OpenRouterSignIn
          prepared={prepared}
          disabled={busy}
          onSignedIn={() => {
            refresh();
            if (!active) enable();
            close();
          }}
        />
      )}
      {/* OpenRouter's sign-in divider names the key field instead. */}
      {!routed && <Label htmlFor="voice-cloud-key">{gt("API key")}</Label>}
      <div className="flex min-w-0 items-start gap-2">
        {sources.length > 0 && (
          <SecretSourceSelect
            value={sourceId}
            sources={sources}
            label={gt("{company} API key", { company })}
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
              aria-label={gt("{company} API key reference", { company })}
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
              aria-label={gt("{company} API key", { company })}
              autoFocus={!routed}
              placeholder={gt("Enter API key")}
              value={draft}
              configured={saved === true}
              disabled={busy}
              maxLength={4096}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </div>
      </div>
      {draft.trim() && !credential ? (
        <p className="text-sm text-muted-foreground">
          {source?.invalidReferenceMessage ??
            gt("Enter an API key, not a URL or secret reference.")}
        </p>
      ) : active && !routed ? (
        <p className="text-sm text-muted-foreground">
          {gt("Updating the key keeps dictation enabled.")}
        </p>
      ) : routed && saved ? (
        <p className="text-sm text-muted-foreground">{gt("Leave blank to keep the saved key.")}</p>
      ) : null}
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
              ? gt("Remove the {company} key?", { company })
              : active
                ? gt("Manage {company} key", { company })
                : gt("Use {name} for dictation?", { name })}
          </DialogTitle>
          <DialogDescription>
            {remove
              ? gt("Everyone using {name} for dictation on {environment} will lose access.", {
                  name,
                  environment: environment.label,
                })
              : active && !routed
                ? gt("Anyone with dictation access to {environment} can use this API key.", {
                    environment: environment.label,
                  })
                : cloudSpeechDisclosure(provider, environment.label, messages)}
          </DialogDescription>
        </DialogHeader>
        {!remove && (
          <DialogPanel>
            {!connected ? (
              <p>
                <T>
                  Connect to <Var>{environment.label}</Var> with dictation access to continue.
                </T>
              </p>
            ) : AsyncResult.isFailure(presence) && saved === undefined ? (
              <Button size="sm" variant="outline" onClick={refresh}>
                <T>Retry loading API key</T>
              </Button>
            ) : routed &&
              AsyncResult.isSuccess(presence) &&
              presence.value &&
              saved === undefined ? (
              <p>
                <T>
                  Update <Var>{environment.label}</Var> to use OpenRouter dictation.
                </T>
              </p>
            ) : saved === undefined ? (
              <p role="status">
                <T>Checking for an API key…</T>
              </p>
            ) : routed ? (
              <form
                id={formId}
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                {editingKey ? (
                  <div className="grid gap-2">{keyField}</div>
                ) : !saved ? (
                  <p>
                    <T>
                      Ask an administrator on <Var>{environment.label}</Var> to add an API key.
                    </T>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    <T>
                      Uses the API key saved on <Var>{environment.label}</Var>. This choice applies
                      only to this device.
                    </T>
                  </p>
                )}
              </form>
            ) : editingKey ? (
              <form
                id={formId}
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                {keyField}
              </form>
            ) : !saved ? (
              <p>
                <T>
                  Ask an administrator on <Var>{environment.label}</Var> to add an API key.
                </T>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                <T>This choice applies only to this device. Choose Off to stop sharing.</T>
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
                <T>Remove key…</T>
              </Button>
            </div>
          )}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
            <T>Cancel</T>
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
                <T>Remove key</T>
              </Button>
            ) : routed ? (
              saved !== undefined && (saved || canManage) ? (
                <Button type="submit" form={formId} size="sm" disabled={busy || !canSubmit}>
                  {active ? gt("Save", { $context: "verb" }) : gt("Save and enable")}
                </Button>
              ) : null
            ) : editingKey ? (
              <Button type="submit" form={formId} size="sm" disabled={busy || !credential}>
                {active ? gt("Save key") : gt("Save and enable")}
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
                <T>
                  Use <Var>{name}</Var>
                </T>
              </Button>
            ) : null)}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
