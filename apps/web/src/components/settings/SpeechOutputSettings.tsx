import {
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  isSecretReference,
  type SecretProviderId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { SystemSpeechSettings } from "./SystemSpeechSettings";
import { nativeSpeechAvailable } from "../../speech/nativeSpeech";
import { useId, useState } from "react";
import * as Schema from "effect/Schema";
import { MonitorIcon, VolumeXIcon } from "lucide-react";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useSpeechOutputDestination } from "../../speech/useSpeechOutputDestination";
import { useSpeechVoiceCatalog } from "../../speech/useSpeechVoiceCatalog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SecretInput } from "./SecretInput";
import { SecretSourceSelect } from "./SecretSourceInput";
import { Input } from "../ui/input";
import { isSecretsFeatureEnabled } from "../../env";
import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import { OpenAI, ElevenLabs } from "../Icons";
import { useElevenLabsVoices } from "../../speech/useElevenLabsVoices";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Button } from "../ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
} from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SpeechPlaybackSpeed } from "../../speech/SpeechPlaybackSpeed";
import { LocalSpeechVoices } from "./LocalSpeechVoices";

const isApiKey = Schema.is(CloudSpeechApiKey);

export function SpeechOutputSettings() {
  const { environments } = useEnvironments();
  const gt = useGT();
  const { destination, choose, canManage, mixedDestination, mixedTarget, mixedRate } =
    useSpeechOutputDestination();
  const [pending, setPending] = useState<{
    environment: EnvironmentPresentation;
    engine: "openai" | "elevenlabs";
  } | null>(null);
  const chosen = environments.find(
    (environment) => environment.environmentId === destination?.environmentId,
  );
  const available = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.voiceSynthesis,
  );
  const value = mixedDestination
    ? "mixed"
    : destination?.engine === "system"
      ? "system"
      : destination
        ? `${destination.engine}:${destination.environmentId}`
        : "off";
  return (
    <SettingsSection id="speech-output" title="Response playback">
      <SettingsRow
        title="Read aloud with"
        description={gt(
          "Playback preferences follow the selected environment or project. Off by default.",
        )}
        settingKeys={["speechPlaybackDestination"]}
        mixed={mixedDestination ?? false}
        control={
          <div className="w-full min-w-0 @min-[32rem]/settings-row:max-w-72">
            <Select
              value={value}
              disabled={!canManage}
              onValueChange={(value) => {
                if (value === "system") {
                  choose({ engine: "system", environmentId: null });
                  return;
                }
                if (value === "off") {
                  choose(null);
                  return;
                }
                const picked = available.find(
                  (environment) =>
                    value === `piper:${environment.environmentId}` ||
                    value === `openai:${environment.environmentId}` ||
                    value === `elevenlabs:${environment.environmentId}`,
                );
                if (!picked) return;
                const engine = value?.startsWith("elevenlabs:")
                  ? "elevenlabs"
                  : value?.startsWith("openai:")
                    ? "openai"
                    : "piper";
                if (engine !== "piper") {
                  const key =
                    engine === "openai"
                      ? picked.serverConfig?.settings.cloudSpeechCredentials.openai
                      : picked.serverConfig?.settings.speechOutput.elevenLabsApiKey;
                  if (!key) {
                    setPending({ environment: picked, engine });
                    return;
                  }
                }
                choose({ environmentId: picked.environmentId, engine });
              }}
            >
              <SelectTrigger size="sm" aria-label="Read aloud with">
                <SelectValue>
                  <span className="flex min-w-0 items-center gap-2">
                    {destination ? (
                      destination.engine === "piper" || destination.engine === "system" ? (
                        <MonitorIcon aria-hidden className="size-4" />
                      ) : destination.engine === "elevenlabs" ? (
                        <ElevenLabs aria-hidden className="size-4 text-foreground" />
                      ) : (
                        <OpenAI aria-hidden className="size-4 text-foreground" />
                      )
                    ) : (
                      <VolumeXIcon aria-hidden className="size-4" />
                    )}
                    <span className="truncate">
                      {" "}
                      {mixedDestination
                        ? gt("Mixed")
                        : destination
                          ? destination.engine === "system"
                            ? gt("System voices")
                            : `${destination.engine === "elevenlabs" ? "ElevenLabs via " : destination.engine === "openai" ? "OpenAI via " : ""}${chosen?.label ?? "Chosen environment (unavailable)"}`
                          : "Off"}
                    </span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {mixedDestination ? (
                  <SelectItem value="mixed" disabled>
                    {gt("Mixed")}
                  </SelectItem>
                ) : null}
                <SelectItem value="off">
                  <span className="flex items-center gap-2">
                    <VolumeXIcon aria-hidden className="size-4" />
                    Off
                  </span>
                </SelectItem>
                {nativeSpeechAvailable() ? (
                  <SelectItem value="system">{gt("System voices")}</SelectItem>
                ) : null}
                <SelectGroup>
                  <SelectGroupLabel>On an environment</SelectGroupLabel>
                  {available.map((environment) => (
                    <SelectItem
                      key={environment.environmentId}
                      value={`piper:${environment.environmentId}`}
                    >
                      <span className="flex items-center gap-2">
                        <MonitorIcon aria-hidden className="size-4" />
                        {environment.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
                {available.map((environment) => (
                  <SelectGroup key={environment.environmentId}>
                    <SelectGroupLabel>Cloud via {environment.label}</SelectGroupLabel>
                    <SelectItem value={`openai:${environment.environmentId}`}>
                      <span className="flex items-center gap-2">
                        <OpenAI aria-hidden className="size-4 text-foreground" />
                        OpenAI
                      </span>
                    </SelectItem>
                    <SelectItem value={`elevenlabs:${environment.environmentId}`}>
                      <span className="flex items-center gap-2">
                        <ElevenLabs aria-hidden className="size-4 text-foreground" />
                        ElevenLabs
                      </span>
                    </SelectItem>
                  </SelectGroup>
                ))}
                {destination &&
                !available.some(
                  (environment) => environment.environmentId === destination.environmentId,
                ) ? (
                  <SelectItem value={value}>Chosen environment (unavailable)</SelectItem>
                ) : null}
              </SelectPopup>
            </Select>
          </div>
        }
      />
      <SettingsRow
        title="Playback speed"
        description={
          destination?.engine === "system"
            ? gt("Speed changes apply to the next segment with system voices.")
            : gt("Adjust listening speed without generating new audio.")
        }
        settingKeys={["speechPlaybackRate"]}
        mixed={mixedRate ?? false}
        control={<SpeechPlaybackSpeed />}
      />
      {!mixedTarget && destination?.engine === "system" ? <SystemSpeechSettings /> : null}
      {!mixedTarget && destination && destination.engine !== "system" && chosen ? (
        destination.engine === "piper" ? (
          <LocalPlaybackSettings key={chosen.environmentId} environment={chosen} />
        ) : (
          <CloudPlaybackSettings
            key={`${chosen.environmentId}:${destination.engine}`}
            environment={chosen}
            engine={destination.engine}
          />
        )
      ) : null}
      {pending ? (
        <SpeechApiKeyDialog
          key={`${pending.environment.environmentId}:${pending.engine}`}
          environment={pending.environment}
          engine={pending.engine}
          configured={false}
          close={() => setPending(null)}
          saved={() => {
            choose({ environmentId: pending.environment.environmentId, engine: pending.engine });
            setPending(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function LocalPlaybackSettings({ environment }: { environment: EnvironmentPresentation }) {
  const catalog = useSpeechVoiceCatalog(environment.environmentId);
  return (
    <>
      <SettingsRow
        title="Piper"
        description={
          catalog.loading
            ? "Checking this environment…"
            : (catalog.error ??
              catalog.runtime?.reason ??
              (catalog.runtime?.state === "ready"
                ? `Installed on ${environment.label}. Runs locally without sending text to a cloud provider.`
                : catalog.runtime?.state === "installing"
                  ? `Installing Piper on ${environment.label}…`
                  : catalog.runtime
                    ? `Download Piper for ${catalog.runtime.platform} on ${environment.label}. No manual installation needed.`
                    : "Reconnect or update this environment to manage Piper."))
        }
        control={
          catalog.runtime ? (
            <Button
              size="sm"
              variant={catalog.runtime.state === "ready" ? "ghost-destructive" : "outline"}
              disabled={
                !catalog.canManage || catalog.busy || catalog.runtime.state === "unsupported"
              }
              onClick={() =>
                void catalog.run(
                  "",
                  catalog.runtime?.state === "ready"
                    ? "removeRuntime"
                    : catalog.runtime?.state === "installing"
                      ? "cancelRuntime"
                      : "installRuntime",
                )
              }
            >
              {catalog.runtime.state === "ready"
                ? "Remove Piper"
                : catalog.runtime.state === "installing"
                  ? "Cancel installation"
                  : "Download Piper"}
            </Button>
          ) : catalog.error ? (
            <Button variant="outline" size="sm" onClick={() => void catalog.refresh()}>
              Try again
            </Button>
          ) : null
        }
      />
      {catalog.runtime?.state === "ready" ? (
        <LocalSpeechVoices environment={environment} catalog={catalog} />
      ) : null}
    </>
  );
}

function OpenAiPlaybackSettings({ environment }: { environment: EnvironmentPresentation }) {
  const gt = useGT();
  const config = useEnvironmentSettings(
    environment.environmentId,
    (settings) => settings.speechOutput,
  );
  const { destination, selectVoice, canManage } = useSpeechOutputDestination();
  const catalog = useSpeechVoiceCatalog(environment.environmentId);
  const provider = catalog.providers.find((provider) => provider.id === "openai");
  const voice = destination?.voice ?? provider?.defaultVoice ?? config.voice;
  return (
    <SettingsRow
      title="OpenAI voice"
      description={
        catalog.error ??
        (catalog.loading
          ? gt("Checking")
          : !provider
            ? gt("Unavailable")
            : "Choose the voice used for response playback.")
      }
      control={
        <div className="flex items-center gap-2">
          <Select
            value={voice}
            disabled={!canManage || !provider}
            onValueChange={(value) => {
              if (provider?.voices.some((voice) => voice.id === value)) selectVoice(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Speech output voice">
              <SelectValue>
                {provider?.voices.find((candidate) => candidate.id === voice)?.name ?? voice}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(provider?.voices ?? []).map((voice) => (
                <SelectItem key={voice.id} value={voice.id}>
                  {voice.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {!provider && !catalog.loading ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!catalog.connected}
              onClick={() => void catalog.refresh()}
            >
              {gt("Try again")}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function CloudPlaybackSettings({
  environment,
  engine,
}: {
  environment: EnvironmentPresentation;
  engine: "openai" | "elevenlabs";
}) {
  const settings = useEnvironmentSettings(environment.environmentId);
  const configured = Boolean(
    engine === "openai"
      ? settings.cloudSpeechCredentials.openai
      : settings.speechOutput.elevenLabsApiKey,
  );
  const canManage = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const [configuring, setConfiguring] = useState(false);
  const [revision, setRevision] = useState(0);
  const label = engine === "openai" ? "OpenAI" : "ElevenLabs";
  return (
    <>
      <SettingsRow
        title={`${label} API key`}
        description={
          configured
            ? `Uses the key saved on ${environment.label}. Response text is sent to ${label}. API charges apply.`
            : `Add an API key on ${environment.label} to choose a voice.`
        }
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!canManage}
            onClick={() => setConfiguring(true)}
          >
            {configured ? "Manage key…" : "Add API key…"}
          </Button>
        }
      />
      {configured ? (
        engine === "openai" ? (
          <OpenAiPlaybackSettings environment={environment} />
        ) : (
          <ElevenLabsVoiceSettings key={revision} environment={environment} />
        )
      ) : null}
      {configuring ? (
        <SpeechApiKeyDialog
          environment={environment}
          engine={engine}
          configured={configured}
          close={() => setConfiguring(false)}
          saved={() => {
            setRevision((value) => value + 1);
            setConfiguring(false);
          }}
        />
      ) : null}
    </>
  );
}

function SpeechApiKeyDialog({
  environment,
  engine,
  configured,
  close,
  saved,
}: {
  environment: EnvironmentPresentation;
  engine: "openai" | "elevenlabs";
  configured: boolean;
  close: () => void;
  saved: () => void;
}) {
  const canManage = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const formId = useId();
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const original =
    engine === "openai"
      ? environment.serverConfig?.settings.cloudSpeechCredentials.openai
      : environment.serverConfig?.settings.speechOutput.elevenLabsApiKey;
  const sources =
    isSecretsFeatureEnabled && environment.serverConfig?.secretReferences
      ? configuredSecretSources(environment.serverConfig.settings.secretProviders)
      : [];
  const reference =
    isSecretReference(original) && sources.some((source) => source.id === original.provider)
      ? original
      : null;
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(reference?.provider ?? null);
  const [draft, setDraft] = useState(reference?.reference ?? "");
  const source = sources.find((source) => source.id === sourceId);
  const credential =
    sourceId !== null
      ? source && secretRequestReference(source, draft)
      : isApiKey(draft.trim())
        ? draft.trim()
        : undefined;
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const label = engine === "openai" ? "OpenAI" : "ElevenLabs";
  const commit = async (key: SettingsSecretValue) => {
    if (!canManage || busy) return;
    setBusy(true);
    const result = await update({
      environmentId: environment.environmentId,
      input: {
        patch:
          engine === "openai"
            ? { cloudSpeechCredentials: { openai: key } }
            : { speechOutput: { elevenLabsApiKey: key } },
      },
    });
    setBusy(false);
    if (result._tag === "Success") saved();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup showCloseButton={!busy} className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {removing
              ? `Remove the ${label} key?`
              : `${configured ? "Manage" : "Add"} ${label} API key`}
          </DialogTitle>
          <DialogDescription>
            {removing
              ? `Everyone using ${label} on ${environment.label} will lose access to this key.`
              : `Stored on ${environment.label}. Response text is sent to ${label}. API charges apply.${engine === "openai" ? " This key is shared with OpenAI transcription." : " Allow Voices: Read to list your voices."}`}
          </DialogDescription>
        </DialogHeader>
        {!removing ? (
          <DialogPanel>
            <form
              id={formId}
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && credential) void commit(credential);
              }}
            >
              <Label htmlFor={`${formId}-value`}>API key</Label>
              <div className="flex min-w-0 items-start gap-2">
                {sources.length > 0 ? (
                  <SecretSourceSelect
                    label={`${label} API key`}
                    value={sourceId}
                    sources={sources}
                    disabled={!canManage || busy}
                    onValueChange={(next) => {
                      setSourceId(next);
                      setDraft("");
                    }}
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  {sourceId !== null ? (
                    <Input
                      id={`${formId}-value`}
                      aria-label={`${label} API key reference`}
                      autoFocus
                      value={draft}
                      placeholder={source?.referencePlaceholder}
                      disabled={!canManage || busy}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={4096}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                  ) : (
                    <SecretInput
                      id={`${formId}-value`}
                      aria-label={`${label} API key`}
                      configured={configured}
                      value={draft}
                      autoFocus
                      disabled={!canManage || busy}
                      maxLength={4096}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                  )}
                </div>
              </div>
              {draft.trim() && !credential ? (
                <p className="text-sm text-destructive">
                  {source?.invalidReferenceMessage ?? "Enter a valid API key, not a URL."}
                </p>
              ) : null}
            </form>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          {configured && !removing ? (
            <div className="sm:mr-auto">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>
                Remove key…
              </Button>
            </div>
          ) : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {removing ? (
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void commit("")}>
              Remove key
            </Button>
          ) : (
            <Button
              size="sm"
              type="submit"
              form={formId}
              disabled={!canManage || busy || !credential}
            >
              Save key
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ElevenLabsVoiceSettings({ environment }: { environment: EnvironmentPresentation }) {
  const config = useEnvironmentSettings(
    environment.environmentId,
    (settings) => settings.speechOutput,
  );
  const catalog = useElevenLabsVoices(environment.environmentId);
  const { destination, selectVoice, canManage } = useSpeechOutputDestination();
  const selected = catalog.voices.find(
    (voice) => voice.id === (destination?.voice ?? config.elevenLabsVoiceId),
  );
  return (
    <>
      <SettingsRow
        title="ElevenLabs voice"
        description={
          !catalog.connected
            ? "Connect to this environment with playback access to load voices."
            : catalog.failed
              ? "Could not load voices. Check the API key has Voices: Read permission, then try again."
              : catalog.loading
                ? "Loading voices…"
                : catalog.voices.length === 0
                  ? "No voices are available for this API key."
                  : "Choose a voice from your ElevenLabs account."
        }
        control={
          <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:max-w-80">
            <div className="min-w-0 flex-1">
              <Select
                value={destination?.voice ?? config.elevenLabsVoiceId}
                disabled={
                  !canManage || !catalog.connected || catalog.loading || catalog.voices.length === 0
                }
                onValueChange={(id) => {
                  if (catalog.voices.some((voice) => voice.id === id)) selectVoice(id!);
                }}
              >
                <SelectTrigger size="sm" aria-label="ElevenLabs voice">
                  <SelectValue>{selected?.name ?? "Current voice"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {!selected ? (
                    <SelectItem value={destination?.voice ?? config.elevenLabsVoiceId} disabled>
                      Current voice
                    </SelectItem>
                  ) : null}
                  {catalog.voices.map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>
                      {voice.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!catalog.connected || catalog.loading}
              onClick={catalog.refresh}
            >
              {catalog.failed ? "Try again" : "Refresh"}
            </Button>
          </div>
        }
      />
      {catalog.hasMore ? (
        <SettingsRow
          title="More voices"
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={catalog.loading}
              onClick={catalog.loadMore}
            >
              Load more voices
            </Button>
          }
        />
      ) : null}
    </>
  );
}
