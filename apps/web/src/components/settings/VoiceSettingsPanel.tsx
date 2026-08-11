import { connectionStatusText, type PreparedConnection } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  fetchVoiceCredentialStatus,
  updateVoiceCredential,
} from "@t3tools/client-runtime/state/voice";
import {
  type EnvironmentId,
  type VoiceCredentialMutation,
  type VoiceCredentialStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { KeyRoundIcon, Mic2Icon, ShieldAlertIcon } from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { runtime } from "../../lib/runtime";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useEnvironmentSessionState, usePreparedConnection } from "../../state/session";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  buildVoiceEnvironmentOptions,
  classifyVoiceEnvironmentAvailability,
  describeVoiceCredentialStatus,
  isVoiceCredentialPermissionDenied,
  resolveSelectedVoiceEnvironmentId,
  resolveVoiceCredentialWriteAccess,
  voiceCredentialErrorMessage,
  type VoiceCredentialWriteAccess,
} from "./VoiceSettingsPanel.logic";

export interface VoiceCredentialApi {
  readonly status: (
    prepared: PreparedConnection,
    signal: AbortSignal,
  ) => Promise<VoiceCredentialStatus>;
  readonly update: (
    prepared: PreparedConnection,
    mutation: VoiceCredentialMutation,
    signal: AbortSignal,
  ) => Promise<VoiceCredentialStatus>;
}

const liveVoiceCredentialApi: VoiceCredentialApi = {
  status: (prepared, signal) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
        return yield* fetchVoiceCredentialStatus({ prepared, signer });
      }),
      { signal },
    ),
  update: (prepared, mutation, signal) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
        return yield* updateVoiceCredential({ prepared, mutation, signer });
      }),
      { signal },
    ),
};

export type VoiceCredentialLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly status: VoiceCredentialStatus }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

function environmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  return environment.displayUrl ?? "Remote device";
}

export function VoiceEnvironmentPicker({
  environments,
  selectedEnvironmentId,
  isReady,
  onSelect,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly isReady: boolean;
  readonly onSelect: (environmentId: EnvironmentId) => void;
}) {
  return (
    <SettingsSection {...searchableSetting("voice-host-environment")}>
      {environments.length === 0 ? (
        <SettingsRow
          title={isReady ? "No connected environments" : "Loading environments"}
          description={
            isReady
              ? "Connect an execution environment before configuring voice."
              : "Reading connected execution environments."
          }
        />
      ) : (
        <div className="grid gap-1 sm:grid-cols-2" role="group" aria-label="Voice host environment">
          {environments.map((environment) => {
            const selected = environment.environmentId === selectedEnvironmentId;
            return (
              <button
                key={environment.environmentId}
                type="button"
                aria-pressed={selected}
                className={
                  selected
                    ? "rounded-xl bg-primary/8 px-3 py-2.5 text-left ring-1 ring-primary/25 sm:px-4 dark:bg-primary/12"
                    : "rounded-xl px-3 py-2.5 text-left hover:bg-muted/40 sm:px-4"
                }
                onClick={() => onSelect(environment.environmentId)}
              >
                <span className="block truncate text-sm font-medium text-foreground">
                  {environment.label}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {environmentDetail(environment)} · {connectionStatusText(environment.connection)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}

export function VoiceUsageNotice() {
  return (
    <SettingsSection title="Voice" icon={<Mic2Icon />}>
      <Alert variant="info">
        <Mic2Icon />
        <AlertTitle>OpenAI Realtime API</AlertTitle>
        <AlertDescription>
          <p>
            OpenAI bills Realtime API usage to the account behind this key. It is separate from
            ChatGPT, Codex, and other provider subscriptions.
          </p>
          <p>
            During a voice session, microphone audio and the work context needed for the
            conversation are sent to OpenAI. This page never requests microphone access or starts a
            session.
          </p>
          <p>Voice selection will be available from the voice panel.</p>
        </AlertDescription>
      </Alert>
    </SettingsSection>
  );
}

export function VoiceCredentialEditor({
  environmentLabel,
  loadState,
  writeAccess,
  apiKey,
  mutationAction,
  notice,
  apiKeyInputRef,
  onApiKeyChange,
  onSave,
  onRemove,
  onRetryStatus,
}: {
  readonly environmentLabel: string;
  readonly loadState: VoiceCredentialLoadState;
  readonly writeAccess: VoiceCredentialWriteAccess;
  readonly apiKey: string;
  readonly mutationAction: VoiceCredentialMutation["action"] | null;
  readonly notice: string | null;
  readonly apiKeyInputRef?: RefObject<HTMLInputElement | null>;
  readonly onApiKeyChange: (apiKey: string) => void;
  readonly onSave: () => void;
  readonly onRemove: () => void;
  readonly onRetryStatus: () => void;
}) {
  const knownDenied = writeAccess === "denied";
  const permissionPending = writeAccess === "pending";
  const canAttemptWrite = !knownDenied && !permissionPending;
  const isUpdating = mutationAction !== null;
  const readyStatus = loadState.kind === "ready" ? loadState.status : null;
  const hasStoredCredential = readyStatus?.configured === true && readyStatus.source === "stored";
  const statusText =
    loadState.kind === "ready"
      ? describeVoiceCredentialStatus(loadState.status)
      : loadState.kind === "loading"
        ? "Checking this environment's credential status."
        : loadState.message;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave();
  };

  return (
    <SettingsSection {...searchableSetting("openai-api-key")} icon={<KeyRoundIcon />}>
      <SettingsRow
        title={`OpenAI API key for ${environmentLabel}`}
        description="The key is sent directly to the selected T3 environment and is never returned to this client."
        status={
          <span role="status" aria-live="polite">
            {statusText}
          </span>
        }
      >
        <div className="mt-3 border-t border-border/60 pt-3">
          {knownDenied ? (
            <Alert variant="warning" className="mb-3">
              <ShieldAlertIcon />
              <AlertTitle>Limited permissions</AlertTitle>
              <AlertDescription>
                Standard remote client links cannot manage this key. Reconnect with access:write
                permission or configure OPENAI_API_KEY on the environment host.
              </AlertDescription>
            </Alert>
          ) : null}
          {loadState.kind === "error" ? (
            <Alert variant="error" className="mb-3">
              <ShieldAlertIcon />
              <AlertTitle>Credential request failed</AlertTitle>
              <AlertDescription>{loadState.message}</AlertDescription>
              <AlertAction>
                <Button type="button" size="xs" variant="outline" onClick={onRetryStatus}>
                  Retry status
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submit}>
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor="voice-openai-api-key">New OpenAI API key</FieldLabel>
              <Input
                nativeInput
                ref={apiKeyInputRef}
                id="voice-openai-api-key"
                name="openai-api-key"
                type="password"
                value={apiKey}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={4_096}
                disabled={!canAttemptWrite || isUpdating}
                onChange={(event) => onApiKeyChange(event.currentTarget.value)}
              />
              <FieldDescription>
                Write-only: saving replaces any key stored by this environment.
              </FieldDescription>
            </Field>
            <div className="flex shrink-0 gap-2">
              {hasStoredCredential ? (
                <Button
                  type="button"
                  variant="destructive-outline"
                  disabled={!canAttemptWrite || isUpdating}
                  onClick={onRemove}
                >
                  {mutationAction === "remove" ? "Removing…" : "Remove stored key"}
                </Button>
              ) : null}
              <Button
                type="submit"
                disabled={!canAttemptWrite || isUpdating || apiKey.trim().length === 0}
              >
                {mutationAction === "set"
                  ? "Saving…"
                  : readyStatus?.configured
                    ? "Replace key"
                    : "Save key"}
              </Button>
            </div>
          </form>
          {readyStatus?.configured === true && readyStatus.source === "environment" ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Host-provided keys cannot be removed here. Change OPENAI_API_KEY on the environment
              host instead.
            </p>
          ) : null}
          {notice ? (
            <p className="mt-3 text-xs text-muted-foreground" role="status" aria-live="polite">
              {notice}
            </p>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

export function ConnectedVoiceCredentialSettings({
  environment,
  prepared,
  credentialApi,
}: {
  readonly environment: EnvironmentPresentation;
  readonly prepared: PreparedConnection;
  readonly credentialApi: VoiceCredentialApi;
}) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const sessionWriteAccess = resolveVoiceCredentialWriteAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
  });
  const [endpointPermissionDeniedFor, setEndpointPermissionDeniedFor] =
    useState<PreparedConnection | null>(null);
  const writeAccess = endpointPermissionDeniedFor === prepared ? "denied" : sessionWriteAccess;
  const shouldRequestStatus = writeAccess === "granted" || writeAccess === "unknown";
  const [statusResult, setStatusResult] = useState<{
    readonly prepared: PreparedConnection;
    readonly state: VoiceCredentialLoadState;
  } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [mutationAction, setMutationAction] = useState<VoiceCredentialMutation["action"] | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [statusRequestVersion, setStatusRequestVersion] = useState(0);
  const [pendingFocusFor, setPendingFocusFor] = useState<PreparedConnection | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const statusAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!shouldRequestStatus) return;
    const controller = new AbortController();
    statusAbortRef.current = controller;
    void credentialApi.status(prepared, controller.signal).then(
      (status) => {
        if (!controller.signal.aborted) {
          setEndpointPermissionDeniedFor((current) => (current === prepared ? null : current));
          setStatusResult({ prepared, state: { kind: "ready", status } });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          if (isVoiceCredentialPermissionDenied(error)) {
            setApiKey("");
            setEndpointPermissionDeniedFor(prepared);
          }
          setStatusResult({
            prepared,
            state: { kind: "error", message: voiceCredentialErrorMessage(error) },
          });
        }
      },
    );
    return () => {
      controller.abort();
      if (statusAbortRef.current === controller) statusAbortRef.current = null;
    };
  }, [credentialApi, prepared, shouldRequestStatus, statusRequestVersion]);

  useEffect(
    () => () => {
      mutationAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (writeAccess === "denied" && apiKey.length > 0) setApiKey("");
  }, [apiKey, writeAccess]);

  useEffect(() => {
    if (pendingFocusFor === null) return;
    if (pendingFocusFor !== prepared) {
      setPendingFocusFor(null);
      return;
    }
    if (mutationAction !== null) return;
    apiKeyInputRef.current?.focus({ preventScroll: true });
    setPendingFocusFor(null);
  }, [mutationAction, pendingFocusFor, prepared]);

  const runMutation = useCallback(
    (mutation: VoiceCredentialMutation) => {
      if (writeAccess === "denied" || writeAccess === "pending" || mutationAction !== null) return;
      if (mutationAbortRef.current && !mutationAbortRef.current.signal.aborted) return;
      statusAbortRef.current?.abort();
      const controller = new AbortController();
      mutationAbortRef.current = controller;
      setMutationAction(mutation.action);
      setNotice(null);
      void credentialApi.update(prepared, mutation, controller.signal).then(
        (status) => {
          if (controller.signal.aborted) return;
          setStatusResult({ prepared, state: { kind: "ready", status } });
          setApiKey("");
          if (mutation.action === "set") {
            setNotice("OpenAI API key saved.");
          } else if (status.configured && status.source === "environment") {
            setNotice(
              "Stored key removed. This environment is now using OPENAI_API_KEY from its host.",
            );
          } else {
            setNotice("Stored OpenAI API key removed.");
          }
          if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
          setMutationAction(null);
          if (mutation.action === "remove") {
            setPendingFocusFor(prepared);
          }
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          const message = voiceCredentialErrorMessage(error);
          if (isVoiceCredentialPermissionDenied(error)) {
            setApiKey("");
            setEndpointPermissionDeniedFor(prepared);
          }
          setStatusResult((current) =>
            current?.prepared === prepared && current.state.kind === "ready"
              ? current
              : { prepared, state: { kind: "error", message } },
          );
          setNotice(message);
          if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
          setMutationAction(null);
        },
      );
    },
    [credentialApi, mutationAction, prepared, writeAccess],
  );

  const retryStatus = useCallback(() => {
    if (writeAccess !== "granted" && writeAccess !== "unknown") return;
    setStatusResult(null);
    setNotice(null);
    setStatusRequestVersion((version) => version + 1);
  }, [writeAccess]);

  const loadState: VoiceCredentialLoadState =
    writeAccess === "pending"
      ? { kind: "unavailable", message: "Checking this session's permissions." }
      : writeAccess === "denied"
        ? {
            kind: "unavailable",
            message: "Credential status is hidden because this session lacks access:write.",
          }
        : statusResult?.prepared === prepared
          ? statusResult.state
          : { kind: "loading" };
  const visibleApiKey = writeAccess === "denied" ? "" : apiKey;

  return (
    <VoiceCredentialEditor
      environmentLabel={environment.label}
      loadState={loadState}
      writeAccess={writeAccess}
      apiKey={visibleApiKey}
      mutationAction={mutationAction}
      notice={notice}
      apiKeyInputRef={apiKeyInputRef}
      onApiKeyChange={setApiKey}
      onSave={() => runMutation({ action: "set", apiKey: visibleApiKey.trim() })}
      onRemove={() => runMutation({ action: "remove" })}
      onRetryStatus={retryStatus}
    />
  );
}

export function SelectedVoiceEnvironmentSettings({
  environment,
  credentialApi,
}: {
  readonly environment: EnvironmentPresentation;
  readonly credentialApi: VoiceCredentialApi;
}) {
  const prepared = usePreparedConnection(environment.environmentId);
  const availability = classifyVoiceEnvironmentAvailability({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    supportsRealtimeVoice:
      environment.serverConfig?.environment.capabilities.realtimeVoice === true,
    hasPreparedConnection: Option.isSome(prepared),
  });

  if (availability.kind !== "ready") {
    return (
      <SettingsSection {...searchableSetting("openai-api-key")} icon={<KeyRoundIcon />}>
        <SettingsRow
          title={
            availability.kind === "unsupported"
              ? "Voice is unsupported"
              : availability.kind === "loading"
                ? "Loading voice settings"
                : "Voice unavailable"
          }
          description={availability.message}
        />
      </SettingsSection>
    );
  }

  if (Option.isNone(prepared)) {
    return (
      <SettingsSection {...searchableSetting("openai-api-key")} icon={<KeyRoundIcon />}>
        <SettingsRow
          title="Loading voice settings"
          description="Preparing a secure connection to this environment."
        />
      </SettingsSection>
    );
  }

  return (
    <ConnectedVoiceCredentialSettings
      environment={environment}
      prepared={prepared.value}
      credentialApi={credentialApi}
    />
  );
}

export function VoiceSettingsPanel({
  credentialApi = liveVoiceCredentialApi,
}: {
  readonly credentialApi?: VoiceCredentialApi;
} = {}) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = useMemo(
    () => buildVoiceEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = resolveSelectedVoiceEnvironmentId(
    options,
    selectedEnvironmentId,
    primaryEnvironmentId,
  );
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;

  return (
    <SettingsPageContainer>
      <VoiceUsageNotice />

      <VoiceEnvironmentPicker
        environments={options}
        selectedEnvironmentId={effectiveEnvironmentId}
        isReady={isReady}
        onSelect={setSelectedEnvironmentId}
      />

      {selectedEnvironment ? (
        <SelectedVoiceEnvironmentSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          credentialApi={credentialApi}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
