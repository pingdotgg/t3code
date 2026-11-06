import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import { getCloudSpeechKeys, setCloudSpeechKey } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  CLOUD_SPEECH_LABELS,
  CLOUD_SPEECH_PROVIDER_NAMES,
  isSecretReference,
  type CloudSpeechProvider,
  type SecretProviderId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import { isSecretsFeatureEnabled } from "../../env";
import { layer, runtime } from "../../lib/runtime";
import { chooseAudioDestination } from "../../speech/voiceConsent";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
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

const cloudKeysAtom = Atom.family((prepared: PreparedConnection | null) =>
  Atom.make(
    prepared ? getCloudSpeechKeys(prepared).pipe(Effect.provide(layer)) : Effect.succeed(null),
  ),
);
const isApiKey = Schema.is(CloudSpeechApiKey);

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
  const formId = useId();
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canUse = useEnvironmentScope(id, AuthOrchestrationOperateScope);
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const keys = cloudKeysAtom(canUse ? prepared : null);
  const presence = useAtomValue(keys);
  const refresh = useAtomRefresh(keys);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  const editing = canManage && saved !== undefined && (active || !saved);
  const connected = canUse && prepared !== null;
  const enable = () => chooseAudioDestination({ kind: "cloud", provider, environmentId: id });
  const action = async (value: SettingsSecretValue | null) => {
    if (!connected || !canManage || busy) return;
    setError("");
    setBusy(true);
    try {
      await runtime.runPromise(setCloudSpeechKey(prepared, provider, value));
      refresh();
      if (!active && value !== null) enable();
      close();
    } catch {
      setError("Couldn’t save this change. Check your connection and try again.");
    }
    setBusy(false);
  };

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
                ? `Manage ${company} key`
                : `Use ${name} for dictation?`}
          </DialogTitle>
          <DialogDescription>
            {remove
              ? `Everyone using ${name} for dictation on ${environment.label} will lose access.`
              : active
                ? `Anyone with dictation access to ${environment.label} can use this API key.`
                : `When you stop recording, ${environment.label} sends your audio and vocabulary hints, including project names, to ${company}.`}
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
            ) : saved === undefined ? (
              <p role="status">Checking for an API key…</p>
            ) : editing ? (
              <form
                id={formId}
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (credential) void action(credential);
                }}
              >
                <Label htmlFor="voice-cloud-key">API key</Label>
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
                        autoFocus
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
                        autoFocus
                        placeholder="Enter API key"
                        value={draft}
                        configured={saved}
                        disabled={busy}
                        maxLength={4096}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                    )}
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  {draft.trim() && !credential
                    ? (source?.invalidReferenceMessage ??
                      "Enter an API key, not a URL or secret reference.")
                    : active
                      ? "Updating the key keeps dictation enabled."
                      : `Anyone with dictation access to ${environment.label} can bill this key.`}
                </p>
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
          {connected && canManage && saved && active && !remove && (
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
                onClick={() => void action(null)}
              >
                Remove key
              </Button>
            ) : editing ? (
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
