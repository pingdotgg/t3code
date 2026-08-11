import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { mintVoiceClientSecret } from "@t3tools/client-runtime/state/voice";
import {
  DEFAULT_REALTIME_VOICE,
  REALTIME_VOICES,
  type EnvironmentId,
  type RealtimeVoice,
} from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { CheckIcon, Mic2Icon, MicOffIcon, SquareIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { environmentCatalog } from "../../connection/catalog";
import { getClientSettings, mergeEnvironmentSettings } from "../../hooks/useSettings";
import { runtime } from "../../lib/runtime";
import { readT3ProjectFileDefaultThreadEnvMode } from "../../lib/t3ProjectFileDefaults";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { RealtimeSessionError } from "../../voice/realtimeSession";
import { useVoicePanelStore } from "../../voice/voicePanelStore";
import {
  createDefaultVoiceToolsController,
  createVoiceSupervisorHostController,
  voiceCredentialSessionError,
  type VoiceSupervisorConfirmation,
} from "../../voice/voiceSupervisorHost";
import { createVoiceStartDefaultsResolver } from "../../voice/voiceStartDefaults";
import { useVoiceSupervisorStore } from "../../voice/voiceSupervisorStore";
import { createVoiceToolsWebRepository } from "../../voice/voiceToolsRepository";
import {
  classifyVoiceEnvironmentAvailability,
  resolveSelectedVoiceEnvironmentId,
  type VoiceEnvironmentAvailability,
} from "../settings/VoiceSettingsPanel.logic";
import { Button } from "../ui/button";
import {
  pendingVoiceConfirmationAnnouncement,
  prepareDesktopMicrophoneAccess,
  readAuthoritativeVoiceHostConnection,
  selectVoicePanelHistory,
  voiceConfirmationPreviewRows,
} from "./VoiceSupervisorHost.logic";

function environmentKind(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  return environment.displayUrl ?? "Remote device";
}

function voiceLabel(voice: RealtimeVoice): string {
  return `${voice[0]?.toUpperCase() ?? ""}${voice.slice(1)}`;
}

export function ConfirmationCard({
  confirmation,
  onConfirm,
  onDeny,
}: {
  readonly confirmation: VoiceSupervisorConfirmation;
  readonly onConfirm: () => void;
  readonly onDeny: () => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const previewRows = voiceConfirmationPreviewRows(confirmation);
  useEffect(() => cardRef.current?.focus({ preventScroll: true }), []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDeny();
    } else if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      event.stopPropagation();
      onConfirm();
    }
  };

  return (
    <article
      ref={cardRef}
      tabIndex={0}
      className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Confirm ${confirmation.action}`}
      onKeyDown={onKeyDown}
    >
      <p className="sr-only" role="status" aria-live="assertive">
        Confirmation required: {confirmation.summary}
      </p>
      <p className="text-xs font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-300">
        Confirmation required
      </p>
      <p className="mt-1 text-sm font-medium">{confirmation.summary}</p>
      {previewRows.length > 0 ? (
        <dl className="mt-3 space-y-2 rounded-md bg-background/70 p-2 text-xs">
          {previewRows.map((row) => (
            <div key={row.label}>
              <dt className="font-medium text-muted-foreground">{row.label}</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" onClick={onConfirm}>
          <CheckIcon />
          Confirm
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDeny}>
          <XIcon />
          Deny
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">Enter confirms · Escape denies</p>
    </article>
  );
}

export function VoiceSupervisorPanel({
  environments,
  selectedEnvironmentId,
  selectedAvailability,
  selectedVoice,
  confirmations,
  startError,
  startPending,
  onClose,
  onSelectEnvironment,
  onSelectVoice,
  onStart,
  onStop,
  onSetMuted,
  onConfirm,
  onDeny,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedAvailability: VoiceEnvironmentAvailability;
  readonly selectedVoice: RealtimeVoice;
  readonly confirmations: ReadonlyArray<VoiceSupervisorConfirmation>;
  readonly startError: string | null;
  readonly startPending: boolean;
  readonly onClose: () => void;
  readonly onSelectEnvironment: (environmentId: EnvironmentId) => void;
  readonly onSelectVoice: (voice: RealtimeVoice) => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onSetMuted: (muted: boolean) => void;
  readonly onConfirm: (confirmation: VoiceSupervisorConfirmation) => void;
  readonly onDeny: (confirmation: VoiceSupervisorConfirmation) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const phase = useVoiceSupervisorStore((state) => state.phase);
  const muted = useVoiceSupervisorStore((state) => state.muted);
  const errorMessage = useVoiceSupervisorStore((state) => state.errorMessage);
  const retainedTranscript = useVoiceSupervisorStore((state) => state.transcript);
  const retainedActivity = useVoiceSupervisorStore((state) => state.activity);
  const active = phase === "connecting" || phase === "connected";
  const controlsLocked = active || startPending;
  const displayedError = startError ?? errorMessage;
  const { transcript, activity, completedAnnouncement } = useMemo(
    () =>
      selectVoicePanelHistory({
        transcript: retainedTranscript,
        activity: retainedActivity,
      }),
    [retainedActivity, retainedTranscript],
  );

  useEffect(() => {
    if (confirmations.length === 0) panelRef.current?.focus({ preventScroll: true });
  }, [confirmations.length]);

  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section
      id="voice-supervisor-panel"
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label="Voice supervisor"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      className="fixed right-3 bottom-16 z-50 flex max-h-[min(44rem,calc(100vh-5rem))] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Voice supervisor</h2>
          <p className="text-xs text-muted-foreground">
            {phase === "connected"
              ? muted
                ? "Connected · microphone muted"
                : "Connected · listening"
              : phase === "connecting"
                ? "Connecting securely"
                : "Talk through work across your environments"}
          </p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Hide voice panel"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs font-medium">
            Host environment
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
              value={selectedEnvironmentId ?? ""}
              disabled={controlsLocked || environments.length === 0}
              onChange={(event) => {
                const selected = environments.find(
                  (environment) => environment.environmentId === event.currentTarget.value,
                );
                if (selected !== undefined) onSelectEnvironment(selected.environmentId);
              }}
            >
              {environments.length === 0 ? <option value="">No environments</option> : null}
              {environments.map((environment) => (
                <option key={environment.environmentId} value={environment.environmentId}>
                  {environment.label} · {environmentKind(environment)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium">
            Voice
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
              value={selectedVoice}
              disabled={controlsLocked}
              onChange={(event) => {
                const selected = REALTIME_VOICES.find(
                  (voice) => voice === event.currentTarget.value,
                );
                if (selected !== undefined) onSelectVoice(selected);
              }}
            >
              {REALTIME_VOICES.map((voice) => (
                <option key={voice} value={voice}>
                  {voiceLabel(voice)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!active && selectedAvailability.kind !== "ready" ? (
          <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {selectedAvailability.message ?? "Select a connected voice-capable environment."}
          </p>
        ) : null}
        {displayedError ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {displayedError}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {active ? (
            <>
              <Button type="button" size="sm" variant="destructive" onClick={onStop}>
                <SquareIcon />
                Stop
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={phase !== "connected"}
                onClick={() => onSetMuted(!muted)}
              >
                {muted ? <Mic2Icon /> : <MicOffIcon />}
                {muted ? "Unmute" : "Mute"}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={selectedAvailability.kind !== "ready" || startPending}
              onClick={onStart}
            >
              <Mic2Icon />
              {startPending ? "Checking microphone" : "Start voice"}
            </Button>
          )}
        </div>

        {confirmations.length > 0 ? (
          <div className="space-y-2" aria-label="Pending voice confirmations">
            {confirmations.map((confirmation) => (
              <ConfirmationCard
                key={`${confirmation.generation}:${confirmation.callId}`}
                confirmation={confirmation}
                onConfirm={() => onConfirm(confirmation)}
                onDeny={() => onDeny(confirmation)}
              />
            ))}
          </div>
        ) : null}

        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Transcript
          </h3>
          <div className="mt-2 space-y-2">
            {transcript.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Conversation appears here after you start.
              </p>
            ) : (
              transcript.map((entry) => (
                <div
                  key={`${entry.speaker}:${entry.id}`}
                  className="rounded-md bg-muted/60 px-3 py-2"
                >
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase">
                    {entry.speaker === "user" ? "You" : "Supervisor"}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm">{entry.text}</p>
                </div>
              ))
            )}
          </div>
          <p className="sr-only" role="status">
            {completedAnnouncement}
          </p>
        </div>

        {activity.length > 0 ? (
          <div>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Activity
            </h3>
            <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
              {activity.map((entry) => (
                <li key={entry.id}>{entry.label}</li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function VoiceSupervisorHost() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const router = useRouter();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const open = useVoicePanelStore((state) => state.open);
  const closeVoicePanel = useVoicePanelStore((state) => state.closeVoicePanel);
  const toggleVoicePanel = useVoicePanelStore((state) => state.toggleVoicePanel);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<RealtimeVoice>(DEFAULT_REALTIME_VOICE);
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<EnvironmentId | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [startPending, setStartPending] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const permissionAttemptRef = useRef(0);
  const openRef = useRef(open);
  const selectedEnvironmentIdRef = useRef(selectedEnvironmentId);
  const selectedVoiceRef = useRef(selectedVoice);
  const environmentsRef = useRef(environments);
  openRef.current = open;
  selectedEnvironmentIdRef.current = selectedEnvironmentId;
  selectedVoiceRef.current = selectedVoice;
  environmentsRef.current = environments;

  const [controller] = useState(() =>
    createVoiceSupervisorHostController({
      state: {
        beginSession: (...args) => useVoiceSupervisorStore.getState().beginSession(...args),
        markConnected: (...args) => useVoiceSupervisorStore.getState().markConnected(...args),
        setMuted: (...args) => useVoiceSupervisorStore.getState().setMuted(...args),
        ingestEvent: (...args) => useVoiceSupervisorStore.getState().ingestEvent(...args),
        failSession: (...args) => useVoiceSupervisorStore.getState().failSession(...args),
        endSession: (...args) => useVoiceSupervisorStore.getState().endSession(...args),
        reset: () => useVoiceSupervisorStore.getState().reset(),
      },
    }),
  );
  const hostSnapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const phase = useVoiceSupervisorStore((state) => state.phase);
  const muted = useVoiceSupervisorStore((state) => state.muted);

  const cancelPendingStart = useCallback(() => {
    permissionAttemptRef.current += 1;
    setStartPending(false);
  }, []);

  const hidePanel = useCallback(() => {
    closeVoicePanel();
  }, [closeVoicePanel]);

  useEffect(() => {
    const unsubscribe = useVoicePanelStore.subscribe((state, previousState) => {
      if (state.open === previousState.open) return;
      openRef.current = state.open;
      if (state.open) return;
      permissionAttemptRef.current += 1;
      setStartPending(false);
      launcherRef.current?.focus({ preventScroll: true });
    });

    return () => {
      unsubscribe();
      permissionAttemptRef.current += 1;
      openRef.current = false;
      useVoicePanelStore.getState().closeVoicePanel();
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    const current = selectedEnvironmentIdRef.current;
    const next = resolveSelectedVoiceEnvironmentId(environments, current, primaryEnvironmentId);
    if (next === current) return;
    selectedEnvironmentIdRef.current = next;
    cancelPendingStart();
    setSelectedEnvironmentId(next);
  }, [cancelPendingStart, environments, primaryEnvironmentId]);

  const selectedEnvironment =
    environments.find((environment) => environment.environmentId === selectedEnvironmentId) ?? null;
  const selectedPrepared = usePreparedConnection(selectedEnvironmentId);
  const selectedAvailability: VoiceEnvironmentAvailability = selectedEnvironment
    ? classifyVoiceEnvironmentAvailability({
        connectionPhase: selectedEnvironment.connection.phase,
        hasServerConfig: selectedEnvironment.serverConfig !== null,
        supportsRealtimeVoice:
          selectedEnvironment.serverConfig?.environment.capabilities.realtimeVoice === true,
        hasPreparedConnection: Option.isSome(selectedPrepared),
      })
    : { kind: "unavailable", message: "No execution environment is available." };

  useEffect(() => {
    if (startPending && selectedAvailability.kind !== "ready") cancelPendingStart();
  }, [cancelPendingStart, selectedAvailability.kind, startPending]);

  useEffect(() => {
    if (phase !== "connecting" && phase !== "connected") {
      setActiveEnvironmentId(null);
      return;
    }
    if (activeEnvironmentId === null) return;
    const environment = environments.find(
      (candidate) => candidate.environmentId === activeEnvironmentId,
    );
    if (
      environment?.connection.phase !== "connected" ||
      environment.serverConfig?.environment.capabilities.realtimeVoice !== true ||
      readAuthoritativeVoiceHostConnection(activeEnvironmentId) === null
    ) {
      controller.hostUnavailable("The selected voice host environment became unavailable.");
    }
  }, [activeEnvironmentId, controller, environments, phase, selectedPrepared]);

  const createToolsController = useCallback(() => {
    const resolveStartThreadDefaults = createVoiceStartDefaultsResolver({
      getCurrentRouteTarget: () => {
        const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
        return resolveThreadRouteTarget(params);
      },
      readComposerDraft: (target) => useComposerDraftStore.getState().getComposerDraft(target),
      readThreadShell,
      readDraftSession: (draftId) => useComposerDraftStore.getState().getDraftSession(draftId),
      readStickyModelState: () => {
        const state = useComposerDraftStore.getState();
        return {
          activeProvider: state.stickyActiveProvider,
          modelSelectionByProvider: state.stickyModelSelectionByProvider,
        };
      },
      readTargetEnvironment: (environmentId) => {
        const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
        return config === null
          ? null
          : {
              providers: config.providers,
              settings: mergeEnvironmentSettings(config.settings, getClientSettings()),
            };
      },
      readPrimaryThreadDefaults: () => appAtomRegistry.get(primaryServerSettingsAtom),
      readProjectFileDefaultThreadEnvMode: readT3ProjectFileDefaultThreadEnvMode,
      readGitState: async (environmentId, cwd) => {
        const [refs, status] = await Promise.all([
          executeAtomQuery(
            appAtomRegistry,
            vcsEnvironment.listRefs({
              environmentId,
              input: { cwd, limit: 100 },
            }),
            { reportDefect: false, reportFailure: false },
          ),
          executeAtomQuery(
            appAtomRegistry,
            vcsEnvironment.status({ environmentId, input: { cwd } }),
            { reportDefect: false, reportFailure: false },
          ),
        ]);
        if (refs._tag === "Failure") throw new Error("Git refs unavailable.");
        return {
          isRepo: refs.value.isRepo,
          refs: refs.value.refs,
          currentBranch:
            status._tag === "Success"
              ? status.value.refName
              : (refs.value.refs.find((ref) => ref.current)?.name ?? null),
        };
      },
    });
    const repository = createVoiceToolsWebRepository({
      readEnvironments: () =>
        environmentsRef.current.map((environment) => {
          const connectionResult = appAtomRegistry.get(
            environmentCatalog.stateAtom(environment.environmentId),
          );
          return {
            environmentId: environment.environmentId,
            label: environment.label,
            connectionState: Option.getOrElse(
              AsyncResult.value(connectionResult),
              () => AVAILABLE_CONNECTION_STATE,
            ),
            shellState: appAtomRegistry.get(
              environmentShell.stateValueAtom(environment.environmentId),
            ),
          };
        }),
      resolveStartThreadDefaults,
      navigate: (input) => navigate(input),
      startThreadTurn,
      interruptThreadTurn,
    });
    return createDefaultVoiceToolsController(repository);
  }, [interruptThreadTurn, navigate, router, startThreadTurn]);

  const start = useCallback(async () => {
    const audioElement = audioRef.current;
    const environmentId = selectedEnvironmentId;
    const voice = selectedVoice;
    if (
      !openRef.current ||
      audioElement === null ||
      environmentId === null ||
      selectedAvailability.kind !== "ready" ||
      Option.isNone(selectedPrepared)
    ) {
      return;
    }
    const permissionAttempt = ++permissionAttemptRef.current;
    setStartError(null);
    setStartPending(true);
    const microphone = await prepareDesktopMicrophoneAccess(window.desktopBridge);
    if (permissionAttempt !== permissionAttemptRef.current) return;
    if (microphone.status === "blocked") {
      setStartError(microphone.message);
      setStartPending(false);
      return;
    }
    const preparedConnection = readAuthoritativeVoiceHostConnection(environmentId);
    if (
      !openRef.current ||
      selectedEnvironmentIdRef.current !== environmentId ||
      selectedVoiceRef.current !== voice ||
      preparedConnection === null
    ) {
      setStartError("The selected voice host environment is no longer available.");
      setStartPending(false);
      return;
    }
    setActiveEnvironmentId(environmentId);
    try {
      controller.start({
        audioElement,
        voice,
        getClientSecret: async (signal) => {
          const currentPreparedConnection = readAuthoritativeVoiceHostConnection(environmentId);
          if (currentPreparedConnection === null) {
            throw new RealtimeSessionError("client_secret_failed");
          }
          try {
            return await runtime.runPromise(
              Effect.gen(function* () {
                const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
                return yield* mintVoiceClientSecret({
                  prepared: currentPreparedConnection,
                  request: { voice },
                  signer,
                });
              }),
              { signal },
            );
          } catch (error) {
            throw voiceCredentialSessionError(error);
          }
        },
        createToolsController,
      });
    } catch {
      setActiveEnvironmentId(null);
      setStartError("T3 Code could not start the voice session.");
    } finally {
      if (permissionAttempt === permissionAttemptRef.current) setStartPending(false);
    }
  }, [
    controller,
    createToolsController,
    selectedAvailability.kind,
    selectedEnvironmentId,
    selectedPrepared,
    selectedVoice,
  ]);

  const pendingConfirmationCount = hostSnapshot.confirmations.length;
  const pendingConfirmationAnnouncement = pendingVoiceConfirmationAnnouncement(
    hostSnapshot.confirmations,
    open,
  );
  const launcherStatus =
    pendingConfirmationCount > 0
      ? `${pendingConfirmationCount} voice confirmation${pendingConfirmationCount === 1 ? "" : "s"} pending; microphone ${phase === "connected" && !muted ? "listening" : "muted"}`
      : phase === "connecting"
        ? "connecting; microphone muted"
        : phase === "connected"
          ? muted
            ? "connected; microphone muted"
            : "connected; microphone listening"
          : phase === "failed"
            ? "voice session failed"
            : "voice session idle";
  const launcherLabel = `${open ? "Hide" : "Open"} voice supervisor; ${launcherStatus}`;
  const launcherIndicatorClass =
    pendingConfirmationCount > 0 || (phase === "connected" && muted)
      ? "bg-amber-500"
      : phase === "connecting"
        ? "bg-sky-500"
        : phase === "connected"
          ? "bg-emerald-500"
          : phase === "failed"
            ? "bg-destructive"
            : null;

  return (
    <>
      <audio ref={audioRef} className="hidden" aria-hidden="true" autoPlay />
      <Button
        ref={launcherRef}
        type="button"
        size="icon"
        className="fixed right-3 bottom-3 z-50 rounded-full shadow-lg"
        aria-label={launcherLabel}
        title={launcherLabel}
        aria-expanded={open}
        aria-pressed={open}
        aria-controls="voice-supervisor-panel"
        onClick={toggleVoicePanel}
      >
        {phase === "connecting" || muted ? <MicOffIcon /> : <Mic2Icon />}
        {launcherIndicatorClass === null ? null : (
          <span
            aria-hidden="true"
            className={`absolute top-0 right-0 size-2.5 rounded-full ring-2 ring-background ${launcherIndicatorClass}`}
          />
        )}
        {pendingConfirmationCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -top-2 -left-2 min-w-5 rounded-full bg-amber-500 px-1 text-center text-[10px] font-semibold text-black"
          >
            {pendingConfirmationCount}
          </span>
        ) : null}
      </Button>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {pendingConfirmationAnnouncement}
      </p>
      {open ? (
        <VoiceSupervisorPanel
          environments={environments}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedAvailability={selectedAvailability}
          selectedVoice={selectedVoice}
          confirmations={hostSnapshot.confirmations}
          startError={startError}
          startPending={startPending}
          onClose={hidePanel}
          onSelectEnvironment={(environmentId) => {
            selectedEnvironmentIdRef.current = environmentId;
            cancelPendingStart();
            setStartError(null);
            setSelectedEnvironmentId(environmentId);
          }}
          onSelectVoice={(voice) => {
            selectedVoiceRef.current = voice;
            cancelPendingStart();
            setStartError(null);
            setSelectedVoice(voice);
          }}
          onStart={start}
          onStop={() => {
            cancelPendingStart();
            setActiveEnvironmentId(null);
            controller.stop();
          }}
          onSetMuted={controller.setMuted}
          onConfirm={(confirmation) =>
            controller.confirm(confirmation.generation, confirmation.callId)
          }
          onDeny={(confirmation) => controller.deny(confirmation.generation, confirmation.callId)}
        />
      ) : null}
    </>
  );
}
