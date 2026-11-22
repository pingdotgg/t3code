import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import { hasFeatureFlag } from "@t3tools/client-runtime/state/server";
import { getCloudSpeechKeys, setCloudSpeechKey } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  CLOUD_SPEECH_PROVIDER_NAMES,
  READ_ALOUD_LABELS,
  isSecretReference,
  type CloudSpeechProvider,
  type SecretProviderId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
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
import { useCloudRead } from "./CloudVoiceConfiguration";
import { SecretInput } from "./SecretInput";
import { SecretSourceSelect } from "./SecretSourceInput";

const isApiKey = Schema.is(CloudSpeechApiKey);

/** Confirms a hosted read-aloud provider, saving the environment's shared key when it has none. */
export function ReadAloudKeyDialog({
  environment,
  provider,
  active,
  onEnable,
  close,
}: {
  environment: Pick<EnvironmentPresentation, "environmentId" | "label" | "serverConfig">;
  provider: CloudSpeechProvider;
  /** Read-aloud already uses this provider here, so the dialog only manages its key. */
  active: boolean;
  onEnable: () => void;
  close: () => void;
}) {
  const id = environment.environmentId;
  const name = READ_ALOUD_LABELS[provider];
  const company = CLOUD_SPEECH_PROVIDER_NAMES[provider];
  const gt = useGT();
  const messages = useMessages();
  const formId = useId();
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canUse = useEnvironmentScope(id, AuthOrchestrationOperateScope);
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const [presence, refresh] = useCloudRead(canUse ? prepared : null, getCloudSpeechKeys);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = AsyncResult.isSuccess(presence) ? presence.value?.[provider] : undefined;
  const existing = environment.serverConfig?.settings?.cloudSpeechCredentials?.[provider];
  const sources =
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
  const connected = canUse && prepared !== null;
  const editingKey = canManage && saved !== undefined && (active || !saved);

  const saveKey = async (value: SettingsSecretValue | null, thenEnable: boolean) => {
    if (!connected || !canManage || busy) return;
    setError("");
    setBusy(true);
    try {
      await runEnvironmentSpeech(setCloudSpeechKey(prepared, provider, value));
      refresh();
      if (thenEnable) onEnable();
      close();
    } catch {
      setError(gt("Couldn’t save this change. Check your connection and try again."));
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
              ? gt("Remove the {company} key?", { company })
              : active
                ? gt("Manage {company} key", { company })
                : gt("Read replies aloud with {name}?", { name })}
          </DialogTitle>
          <DialogDescription>
            {remove
              ? gt(
                  "Everyone using {company} for dictation or read aloud on {environment} will lose access.",
                  { company, environment: environment.label },
                )
              : gt(
                  "Replies you play are sent to {company} through {environment}, which bills its API key. The key is shared with dictation.",
                  { company, environment: environment.label },
                )}
          </DialogDescription>
        </DialogHeader>
        {!remove && (
          <DialogPanel>
            {!connected ? (
              <p>
                <T>
                  Connect to <Var>{environment.label}</Var> to continue.
                </T>
              </p>
            ) : AsyncResult.isFailure(presence) && saved === undefined ? (
              <Button size="sm" variant="outline" onClick={refresh}>
                <T>Retry loading API key</T>
              </Button>
            ) : saved === undefined ? (
              <p role="status">
                <T>Checking for an API key…</T>
              </p>
            ) : editingKey ? (
              <form
                id={formId}
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (credential !== undefined) void saveKey(credential, !active);
                }}
              >
                <Label htmlFor="read-aloud-cloud-key">
                  <T>API key</T>
                </Label>
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
                        id="read-aloud-cloud-key"
                        aria-label={gt("{company} API key reference", { company })}
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
                        id="read-aloud-cloud-key"
                        aria-label={gt("{company} API key", { company })}
                        autoFocus
                        placeholder={gt("Enter API key")}
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
                      gt("Enter an API key, not a URL or secret reference."))
                    : active
                      ? gt("Updating the key keeps read aloud on.")
                      : gt("Anyone with access to {environment} can bill this key.", {
                          environment: environment.label,
                        })}
                </p>
              </form>
            ) : !saved ? (
              <p>
                <T>
                  Ask an administrator on <Var>{environment.label}</Var> to add an API key.
                </T>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                <T>
                  Uses the API key saved on <Var>{environment.label}</Var>. This choice applies only
                  to this device.
                </T>
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
            ) : editingKey ? (
              <Button type="submit" form={formId} size="sm" disabled={busy || !credential}>
                {active ? gt("Save key") : gt("Save and enable")}
              </Button>
            ) : saved && !active ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  onEnable();
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
