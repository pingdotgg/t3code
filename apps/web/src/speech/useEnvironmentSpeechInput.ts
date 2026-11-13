import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  postProcessEnvironmentTranscript,
  resolveTranscriptCommit,
  selectEnvironmentSpeechModel,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type HeldVoiceTranscript,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { AuthOrchestrationOperateScope, CLOUD_SPEECH_LABELS } from "@t3tools/contracts";
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  ProjectId,
  SpeechPostProcessingOptions,
  SpeechStreamText,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { chooseSetupSpeechModel, resolveSpeechVocabulary } from "@t3tools/shared/speech";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { toastManager } from "../components/ui/toast";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { chooseRecordingMicrophone } from "./browserMicrophones";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { preferredSpeechLanguages } from "./preferredSpeechLanguages";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { bindAudioGrant, readCleanupGrant, useAudioChoice } from "./voiceConsent";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const WAITING_STATE: VoiceInputState = { phase: "preparing", error: null, errorAction: null };
const INITIAL_SETUP = {
  open: false,
  step: 0,
  model: null as EnvironmentSpeechModel | null,
  language: null as string | null,
  downloading: false,
  catalogFailed: false,
  error: null as string | null,
};

// Every mounted editor shares one status probe per destination; starting a recording refreshes it.
const statusProbes = new WeakMap<PreparedConnection, Promise<EnvironmentSpeechStatus>>();
function probeSpeechStatus(prepared: PreparedConnection, refresh = false) {
  const cached = refresh ? undefined : statusProbes.get(prepared);
  if (cached) return cached;
  const probe = runEnvironmentSpeech(getEnvironmentSpeechStatus(prepared));
  statusProbes.set(prepared, probe);
  probe.catch(() => {
    if (statusProbes.get(prepared) === probe) statusProbes.delete(prepared);
  });
  return probe;
}

type HeldSend = {
  readonly state: VoiceInputState;
  /** Set once transcription and cleanup finished; committed when the owner is next shown. */
  readonly landed: HeldVoiceTranscript | null;
  readonly submit: (text: string) => void;
  readonly cancel: () => void;
  readonly skipPostProcessing: () => void;
  /** The consent it was recorded under; turning voice input off or re-pointing it cancels the send. */
  readonly grantId: string;
  /** The only editor that may deliver it, or null when any editor showing the owner may. */
  readonly editor: object | null;
};

// Sends confirmed during dictation whose draft left the screen before the transcript landed, by owner.
const heldSends = new Map<string, HeldSend>();
const heldSendListeners = new Set<() => void>();
function setHeldSend(ownerKey: string, held: HeldSend | null) {
  if (held) heldSends.set(ownerKey, held);
  else heldSends.delete(ownerKey);
  for (const listener of heldSendListeners) listener();
}
function subscribeHeldSends(listener: () => void) {
  heldSendListeners.add(listener);
  return () => void heldSendListeners.delete(listener);
}

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

function cleanupContext({ text, selection }: DraftInput): DraftInput {
  const limit = 1_024;
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  const before = text.slice(Math.max(0, start - limit), start);
  const selected = text.slice(start, Math.min(end, start + limit));
  return {
    text: before + selected + text.slice(end, end + limit),
    selection: { start: before.length, end: before.length + selected.length },
  };
}

type HookInput = {
  /** The draft's own environment. Optional transcript cleanup runs there, never on the audio destination. */
  readonly environmentId: EnvironmentId;
  /** The draft's project: its vocabulary on that environment and its name become recognition hints. */
  readonly projectId?: ProjectId | null | undefined;
  readonly projectName?: string | null | undefined;
  readonly ownerKey: string;
  readonly disabled?: boolean | undefined;
  /**
   * Until a destination is chosen, voice input is offered and its first gesture opens Voice
   * settings. False hides it instead, for editors whose draft would not survive the navigation.
   */
  readonly offerSetup?: boolean | undefined;
  /**
   * A send confirmed during dictation survives an owner change: its transcript still lands, and
   * it is committed and submitted when this editor shows that owner again. True also keeps it
   * when the editor unmounts, for the next editor mounted with that owner; the submit callback
   * must then reach whichever editor shows the owner, not the one that queued it.
   */
  readonly holdConfirmedSend?: boolean | undefined;
  /** False keeps the transcript off the cleanup provider even when cleanup is on; the model test uses it. */
  readonly cleanup?: boolean | undefined;
  readonly readDraft: () => DraftInput;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
};

/**
 * Microphone audio leaves this device only for the environment the person chose in
 * Voice settings. Nothing is inferred from the primary or the draft's environment, and
 * the recording is abandoned the moment that choice changes or its connection drops.
 */
export function useVoiceTranscriptionDestination() {
  const hydrated = useClientSettingsHydrated();
  const choice = useAudioChoice();
  const grant = choice === "off" ? null : choice;
  const environmentId = hydrated && grant ? grant.destination.environmentId : null;
  const environment = useEnvironment(environmentId);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const canDictate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const cloud = grant?.destination.kind === "cloud" ? grant.destination : undefined;
  const provider = cloud?.provider;
  const model = cloud?.provider === "openrouter" ? cloud.model : undefined;
  const supported =
    environment?.serverConfig?.environment.capabilities[
      provider ? "cloudVoiceTranscription" : "voiceTranscription"
    ] === true;
  return {
    ...(hydrated && choice === null ? { offerFirstRunSetup: true } : {}),
    environmentId,
    ...(provider ? { cloudProvider: provider } : {}),
    ...(model ? { cloudModel: model } : {}),
    grantId: grant?.id ?? null,
    label:
      provider && environment
        ? `${CLOUD_SPEECH_LABELS[provider]} via ${environment.label}`
        : (environment?.label ?? null),
    prepared: supported && canDictate ? connection : null,
  };
}

export function useEnvironmentSpeechInput(input: HookInput) {
  const navigate = useNavigate();
  const destination = useVoiceTranscriptionDestination();
  const prepared = destination.prepared;
  const grantId = destination.grantId;
  const cloudProvider = destination.cloudProvider;
  const cloudModel = destination.cloudModel;
  const draftCapabilities = useEnvironment(input.environmentId)?.serverConfig?.environment
    .capabilities;
  const originatingConnection = Option.getOrNull(usePreparedConnection(input.environmentId));
  const canCleanUp = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const cleanupPrepared =
    canCleanUp &&
    (draftCapabilities?.voiceTranscription || draftCapabilities?.cloudVoiceTranscription)
      ? originatingConnection
      : null;
  const clientSettings = useClientSettings();
  const projectId = input.projectId ?? null;
  const projectWords = useEnvironmentSettings(
    input.environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.speechProjectCustomWords,
  );
  const [status, setStatus] = useState<{
    readonly prepared: PreparedConnection;
    readonly value: EnvironmentSpeechStatus | null;
  } | null>(null);
  const [controllerState, setControllerState] = useState({
    prepared,
    grantId,
    value: INITIAL_STATE,
  });
  const [queuedStart, setQueuedStart] = useState<PreparedConnection | null>(null);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<SpeechStreamText | null>(null);
  const [setup, setSetup] = useState(INITIAL_SETUP);
  const [controllerEpoch, setControllerEpoch] = useState(0);
  const [editor] = useState(() => ({}));
  const held = useSyncExternalStore(subscribeHeldSends, () => {
    const send = heldSends.get(input.ownerKey);
    return send && (send.editor === null || send.editor === editor) ? send : undefined;
  });
  const heldRunning = held && !held.landed && !input.disabled ? held : null;
  const heldConsented = !held || held.grantId === grantId;
  const [previousOwner, setPreviousOwner] = useState({
    key: input.ownerKey,
    disabled: input.disabled,
  });
  if (controllerState.prepared !== prepared || controllerState.grantId !== grantId) {
    setControllerState({ prepared, grantId, value: INITIAL_STATE });
    setSetup(INITIAL_SETUP);
    setQueuedStart(null);
    setPreview(null);
    setLevel(0);
  }
  if (previousOwner.key !== input.ownerKey || previousOwner.disabled !== input.disabled) {
    setPreviousOwner({ key: input.ownerKey, disabled: input.disabled });
    setQueuedStart(null);
    setSetup(INITIAL_SETUP);
  }
  const state: VoiceInputState = heldRunning
    ? heldRunning.state
    : queuedStart === prepared && prepared
      ? WAITING_STATE
      : controllerState.prepared === prepared
        ? controllerState.value
        : INITIAL_STATE;

  const controllerRef = useRef<VoiceInputController | null>(null);
  const startRequestRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    ownerKey: string;
    submit: (text: string) => void;
    text?: string;
  } | null>(null);
  const latestRef = useRef({ input, clientSettings, cleanupPrepared, projectWords });
  const holdRef = useRef<
    | ((
        ownerKey: string,
        submit: (text: string) => void,
        shown: typeof latestRef.current,
        editor: object | null,
      ) => boolean)
    | null
  >(null);
  /** Moves a confirmed send, with its running controller, to the held sends. `shown` is its owner's last render. */
  const holdPendingSend = useStableCallback((shown: typeof latestRef.current) => {
    const pending = pendingSubmissionRef.current;
    if (!pending || pending.text !== undefined) return false;
    const owner = shown.input.holdConfirmedSend ? null : editor;
    if (!holdRef.current?.(pending.ownerKey, pending.submit, shown, owner)) return false;
    pendingSubmissionRef.current = null;
    controllerRef.current = null;
    holdRef.current = null;
    return true;
  });
  const previousOwnerRef = useRef(input.ownerKey);
  // Runs before latestRef is republished, so it still holds the previous owner's render.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons the recording when the draft's owner changes, holding a confirmed send for that owner instead
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey && !input.disabled) return;
    const ownerLeft = previousOwnerRef.current !== input.ownerKey;
    previousOwnerRef.current = input.ownerKey;
    startRequestRef.current += 1;
    if (ownerLeft && holdPendingSend(latestRef.current)) {
      setControllerState((current) => ({ ...current, value: INITIAL_STATE }));
      setPreview(null);
      setLevel(0);
      setControllerEpoch((epoch) => epoch + 1);
      return;
    }
    pendingSubmissionRef.current = null;
    controllerRef.current?.ownerChanged();
  }, [input.ownerKey, input.disabled, holdPendingSend]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed props and settings to the asynchronous recording controller
  useEffect(() => {
    latestRef.current = { input, clientSettings, cleanupPrepared, projectWords };
  });
  // Declared before the controller's effect so an unmount holds the send before that disposes it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- on unmount, cancels the sends only this editor could deliver and keeps a confirmed one that outlives it
  useEffect(
    () => () => {
      for (const send of heldSends.values()) if (send.editor === editor) send.cancel();
      if (latestRef.current.input.holdConfirmedSend) holdPendingSend(latestRef.current);
    },
    [editor, holdPendingSend],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the recording controller bound to the consented destination; it is disposed with the consent
  useEffect(() => {
    if (!prepared || !grantId || typeof navigator === "undefined") return;
    const hasAudioConsent = bindAudioGrant(grantId);
    let disposed = false;
    let controller: VoiceInputController;
    let heldOwner: string | null = null;
    let heldLatest: typeof latestRef.current | null = null;
    let recordingPreferences:
      | {
          readonly cleanup: SpeechPostProcessingOptions | null;
          readonly cleanupGrant: string | null;
          readonly environmentId: EnvironmentId;
        }
      | undefined;

    const readDraft = (): VoiceDraftSnapshot | null => {
      if (heldOwner !== null) return null;
      const current = latestRef.current.input;
      const draft = current.readDraft();
      return { ownerKey: current.ownerKey, text: draft.text, selection: draft.selection };
    };
    const platform = createBrowserVoiceInputPlatform({
      prepared,
      cloudProvider,
      cloudModel,
      hasAudioConsent,
      getTranscriptionOptions: (): SpeechTranscriptionOptions => {
        const {
          clientSettings: settings,
          projectWords: project,
          input: current,
        } = latestRef.current;
        const cleanupGrant = current.cleanup === false ? null : readCleanupGrant();
        const cleanupEnabled = cleanupGrant !== null;
        const cue =
          cleanupEnabled && latestRef.current.cleanupPrepared ? settings.speechCorrectionWord : "";
        const speechCustomWords = resolveSpeechVocabulary({
          personal: settings.speechCustomWords,
          project,
          hints: [cue, current.projectName ?? ""],
        });
        recordingPreferences = {
          cleanupGrant,
          environmentId: current.environmentId,
          cleanup: cleanupEnabled
            ? {
                speechCustomWords,
                speechPostProcessingPrompt: settings.speechPostProcessingPrompt,
                ...(cue.trim() ? { speechCorrectionWord: cue } : {}),
              }
            : null,
        };
        return {
          speechLanguage: settings.speechLanguage,
          speechTranslateToEnglish: settings.speechTranslateToEnglish,
          speechCustomWords,
          speechRemoveFillerWords: settings.speechRemoveFillerWords,
          ...(cue.trim() ? { speechCorrectionWord: cue } : {}),
          speechSilenceFiltering: settings.speechSilenceFiltering,
        };
      },
      getMicrophoneId: chooseRecordingMicrophone,
      onLevel: setLevel,
      onDurationLimit: () => void controller.stop(),
      onText: (text) => {
        if (!disposed) setPreview(text);
      },
      onError: (message) => {
        if (!disposed) void controller.interruptRecording(message);
      },
    });
    const postProcess: NonNullable<VoiceInputControllerDependencies["postProcess"]> = (
      transcript,
      options,
    ) => {
      const preferences = recordingPreferences;
      const { input: current, cleanupPrepared: target } = heldLatest ?? latestRef.current;
      if (
        !preferences?.cleanup ||
        !hasAudioConsent() ||
        preferences.cleanupGrant !== readCleanupGrant() ||
        current.cleanup === false ||
        current.environmentId !== preferences.environmentId ||
        current.ownerKey !== options.draft.ownerKey
      )
        return null;
      if (!target)
        return Promise.reject(
          new Error("The draft's environment is unavailable for transcript cleanup."),
        );
      return runEnvironmentSpeech(
        postProcessEnvironmentTranscript(
          target,
          transcript,
          cleanupContext(options.draft),
          preferences.cleanup,
          () => hasAudioConsent() && preferences.cleanupGrant === readCleanupGrant(),
        ),
        options,
      ).then((result) => result.text);
    };
    controller = new VoiceInputController({
      retryFailedRecording: true,
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: async () => platform.cancelRecording(),
      deleteRecording: platform.deleteRecording,
      postProcess,
      onPostProcessingError: () =>
        toastManager.add({
          type: "warning",
          title: "Transcript cleanup failed",
          description: "The original transcript was added.",
        }),
      readDraft,
      commitDraft: (text, selection) => {
        if (latestRef.current.input.disabled) return;
        latestRef.current.input.commitDraft(text, selection);
        if (pendingSubmissionRef.current) pendingSubmissionRef.current.text = text;
      },
      holdTranscript: (landed) => {
        const current = heldOwner === null ? undefined : heldSends.get(heldOwner);
        if (heldOwner === null || current?.cancel !== cancelHeld) return false;
        setHeldSend(heldOwner, hasAudioConsent() ? { ...current, landed } : null);
        return true;
      },
      onStateChange: (value) => {
        if (heldOwner !== null) {
          const current = heldSends.get(heldOwner);
          if (current?.cancel !== cancelHeld || current.landed || value.phase === "idle") return;
          if (value.phase !== "error") return setHeldSend(heldOwner, { ...current, state: value });
          setHeldSend(heldOwner, null);
          if (hasAudioConsent())
            toastManager.add({
              type: "error",
              title: "Dictated message was not sent",
              description: "Voice input could not finish transcribing it.",
            });
          return;
        }
        if (disposed) return;
        if (value.phase === "error") pendingSubmissionRef.current = null;
        setControllerState({ prepared, grantId, value });
        if (value.phase !== "recording" && value.phase !== "transcribing") setPreview(null);
      },
    });
    const cancelHeld = () => {
      if (heldOwner !== null) setHeldSend(heldOwner, null);
      controller.cancel();
    };
    const hold: NonNullable<typeof holdRef.current> = (ownerKey, submit, shown, editor) => {
      const state = controller.currentState;
      if (state.phase !== "transcribing" && state.phase !== "post-processing") return false;
      heldSends.get(ownerKey)?.cancel();
      heldOwner = ownerKey;
      heldLatest = shown;
      setHeldSend(ownerKey, {
        state,
        landed: null,
        submit,
        cancel: cancelHeld,
        skipPostProcessing: () => controller.skipPostProcessing(),
        grantId,
        editor,
      });
      return true;
    };
    controllerRef.current = controller;
    holdRef.current = hold;
    return () => {
      disposed = true;
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      if (heldOwner === null) controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      if (holdRef.current === hold) holdRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new epoch replaces the controller that left with a held send.
  }, [prepared, grantId, cloudProvider, cloudModel, controllerEpoch]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes the chosen environment's speech status once its connection is available
  useEffect(() => {
    if (!prepared || cloudProvider) return;
    let disposed = false;
    void probeSpeechStatus(prepared)
      .then((value) => {
        if (!disposed) setStatus({ prepared, value });
      })
      .catch(() => {
        if (!disposed) setStatus({ prepared, value: null });
      });
    return () => {
      disposed = true;
    };
  }, [prepared, cloudProvider]);
  const currentStatus = !cloudProvider && status?.prepared === prepared ? status.value : null;
  const setupModelId = setup.model?.id;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls download progress while the setup dialog owns an active model download
  useEffect(() => {
    if (!setup.open || !setup.downloading || !prepared || !setupModelId) return;
    let disposed = false;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void runEnvironmentSpeech(getEnvironmentSpeechModels(prepared))
        .then((result) => {
          if (disposed) return;
          const model = result.models.find((candidate) => candidate.id === setupModelId) ?? null;
          if (model) setSetup((current) => ({ ...current, model }));
        })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    }, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [prepared, setup.downloading, setup.open, setupModelId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delivers a queued submission only after the transcript has committed to the draft
  useEffect(() => {
    const pending = pendingSubmissionRef.current;
    if (state.phase !== "idle" || held || !pending) return;
    pendingSubmissionRef.current = null;
    if (!input.disabled && pending.ownerKey === input.ownerKey && pending.text !== undefined)
      pending.submit(pending.text);
  }, [state, held, input.ownerKey, input.disabled]);

  // Declared after the delivery above, which submits on the render that follows this commit.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- commits a held transcript to its draft once an editor shows that owner
  useEffect(() => {
    if (held && !heldConsented) return held.cancel();
    if (!held?.landed || input.disabled) return;
    const current = latestRef.current.input;
    setHeldSend(input.ownerKey, null);
    const result = resolveTranscriptCommit(
      held.landed.draft,
      { ownerKey: input.ownerKey, ...current.readDraft() },
      held.landed.transcript,
      held.landed.locale,
    );
    if (result.kind !== "commit") return;
    current.commitDraft(result.text, result.selection);
    pendingSubmissionRef.current = {
      ownerKey: input.ownerKey,
      submit: held.submit,
      text: result.text,
    };
  }, [held, heldConsented, input.ownerKey, input.disabled]);

  const submitAfterDictation = useStableCallback((submit: (text: string) => void) => {
    if (latestRef.current.input.disabled || state.phase === "preparing" || heldRunning) return;
    const controller = controllerRef.current;
    if (!controller || !voiceInputBlocksSubmission(state)) {
      submit(latestRef.current.input.readDraft().text);
      return;
    }
    if (pendingSubmissionRef.current) return;
    pendingSubmissionRef.current = { ownerKey: latestRef.current.input.ownerKey, submit };
    if (controller.currentState.phase === "recording") void controller.stop();
  });

  const loadSetupCatalog = useStableCallback(
    async (connection: PreparedConnection, selectedModelId: string, request: number) => {
      setSetup({ ...INITIAL_SETUP, open: true });
      const catalog = await runEnvironmentSpeech(getEnvironmentSpeechModels(connection)).catch(
        () => null,
      );
      if (request !== startRequestRef.current) return;
      const choice = chooseSetupSpeechModel(catalog?.models ?? [], {
        selectedModelId,
        intent: latestRef.current.clientSettings.speechLanguage,
        preferred: preferredSpeechLanguages(),
      });
      setSetup((current) => ({
        ...current,
        model: choice?.model ?? null,
        language: choice?.language ?? null,
        catalogFailed: catalog === null,
        error: choice
          ? null
          : catalog
            ? "No model matches your language. Choose a model or change the language in Voice settings."
            : "Could not load transcription models. Check the connection and try again.",
      }));
    },
  );

  const start = useStableCallback(async () => {
    if (latestRef.current.input.disabled || (setup.open && setup.downloading) || heldRunning)
      return;
    if (!grantId) {
      if (destination.offerFirstRunSetup && latestRef.current.input.offerSetup !== false)
        await navigate({ to: "/settings/voice", hash: "voice-transcription-destination" });
      return;
    }
    const request = ++startRequestRef.current;
    const controller = controllerRef.current;
    const owner = latestRef.current.input.ownerKey;
    if (!controller || !prepared) return;
    if (cloudProvider) {
      setLevel(0);
      await controller.start();
      return;
    }
    const stillCurrent = () =>
      request === startRequestRef.current &&
      controllerRef.current === controller &&
      latestRef.current.input.ownerKey === owner &&
      !latestRef.current.input.disabled;
    setSetup(INITIAL_SETUP);
    setQueuedStart(prepared);
    let latestStatus: EnvironmentSpeechStatus;
    try {
      latestStatus = await probeSpeechStatus(prepared, true);
    } catch (error) {
      if (!stillCurrent()) return;
      setQueuedStart(null);
      toastManager.add({
        type: "error",
        title: "Could not start voice input",
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!stillCurrent()) return;
    setStatus({ prepared, value: latestStatus });
    setQueuedStart(null);
    if (latestStatus.supported && latestStatus.state === "missing-model") {
      return loadSetupCatalog(prepared, latestStatus.modelId, request);
    }
    if (!latestStatus.supported) {
      toastManager.add({
        type: "error",
        title: "Voice input is not available",
        description: latestStatus.reason,
      });
      return;
    }
    setLevel(0);
    await controller.start();
  });

  const downloadSetupModel = useStableCallback(async () => {
    if (!prepared || !currentStatus?.supported || !setupModelId || setup.downloading) return;
    const modelId = setupModelId;
    const request = ++startRequestRef.current;
    setSetup((current) => ({ ...current, downloading: true, error: null }));
    try {
      const { models } = await runEnvironmentSpeech(
        downloadEnvironmentSpeechModel(prepared, modelId),
      );
      if (request !== startRequestRef.current) return;
      // A download cancelled from elsewhere still resolves, so select the model only once it landed.
      const installed = models.some(({ id, state }) => id === modelId && state === "installed");
      if (installed && modelId !== currentStatus.modelId) {
        try {
          await runEnvironmentSpeech(selectEnvironmentSpeechModel(prepared, modelId));
        } catch {
          if (request !== startRequestRef.current) return;
          setSetup((current) => ({
            ...current,
            downloading: false,
            error: "The model downloaded, but this environment could not select it. Try again.",
          }));
          return;
        }
      }
      if (request !== startRequestRef.current) return;
      const next = await probeSpeechStatus(prepared, true);
      if (request !== startRequestRef.current) return;
      setStatus({ prepared, value: next });
      const ready =
        installed && next.supported && next.modelId === modelId && next.state !== "missing-model";
      setSetup((current) => ({
        ...current,
        downloading: false,
        step: ready ? 1 : current.step,
        error: ready ? null : "The model is not ready. Try downloading it again.",
      }));
    } catch {
      if (request !== startRequestRef.current) return;
      setSetup((current) => ({
        ...current,
        downloading: false,
        error: "Could not download the model. Check this environment's connection and try again.",
      }));
    }
  });

  const cancelSetupDownload = useStableCallback(async () => {
    if (!prepared || !setupModelId) return;
    startRequestRef.current += 1;
    setSetup((current) => ({ ...current, open: false, downloading: false }));
    try {
      await runEnvironmentSpeech(cancelEnvironmentSpeechModelDownload(prepared, setupModelId));
    } catch (error) {
      setSetup((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  const destinationReady =
    grantId === null
      ? Boolean(destination.offerFirstRunSetup) && input.offerSetup !== false
      : prepared !== null &&
        (cloudProvider !== undefined ||
          (status?.prepared === prepared && status.value?.supported !== false));
  return {
    available:
      destinationReady &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
    transcriptionEnvironmentId: destination.environmentId,
    transcriptionEnvironmentLabel: destination.label,
    setup: {
      ...setup,
      setOpen: (open: boolean) => setSetup((current) => ({ ...current, open })),
      retryCatalog:
        setup.open && setup.catalogFailed && prepared && currentStatus?.supported
          ? () => loadSetupCatalog(prepared, currentStatus.modelId, ++startRequestRef.current)
          : null,
      download: downloadSetupModel,
      cancelDownload: cancelSetupDownload,
      startRecording: async () => {
        setSetup((current) => ({ ...current, open: false }));
        await start();
      },
    },
    state,
    preview: state.phase === "recording" || state.phase === "transcribing" ? preview : null,
    level,
    preparing: state.phase === "preparing",
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputBlocksSubmission(state),
    start,
    submitAfterDictation,
    stop: useStableCallback(() => controllerRef.current?.stop() ?? Promise.resolve()),
    cancel: useStableCallback(() => {
      held?.cancel();
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      setSetup(INITIAL_SETUP);
      controllerRef.current?.cancel();
    }),
    skipPostProcessing: useStableCallback(() =>
      heldRunning ? heldRunning.skipPostProcessing() : controllerRef.current?.skipPostProcessing(),
    ),
  };
}
