import { useAtomValue } from "@effect/atom-react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, CLOUD_SPEECH_LABELS } from "@t3tools/contracts";
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  ProjectId,
  SpeechBenchmarkTier,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { chooseSetupSpeechModel } from "@t3tools/shared/speech";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { msg, useGT } from "gt-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { preferredSpeechLanguages } from "./preferredSpeechLanguages";
import {
  cancelSpeechModelDownload,
  isSpeechModelSelectError,
  noSpeechDownloadProgressAtom,
  readSpeechModels,
  setUpSpeechModel,
  speechDownloadProgressAtom,
  speechStatusAtom,
  unreadSpeechStatusAtom,
} from "./speechCommands";
import { useAudioChoice } from "./voiceConsent";
import {
  IDLE_VOICE_STATE,
  presentVoiceOwner,
  useRetainedVoiceInputSession,
  useVoiceInputSessionActivity,
  useVoiceInputSessionSnapshot,
  type VoiceInputTarget,
} from "./voiceInputSession";

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

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

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
  /** False keeps the transcript off the cleanup provider even when cleanup is on; the model test uses it. */
  readonly cleanup?: boolean | undefined;
  readonly readDraft: () => DraftInput;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  /** Names the draft in the indicator shown while a recording's editor is off screen. */
  readonly label?: string | null | undefined;
  /** False while the editor stays mounted out of sight, so the indicator still shows. */
  readonly presented?: boolean | undefined;
  /**
   * A draft that is stored outside its editor keeps recording when the editor shows another
   * owner or unmounts; the transcript lands in the stored draft instead.
   */
  readonly persistentDraft?:
    | {
        readonly readStoredText: () => string | null;
        readonly commitStoredText: (text: string) => void;
        readonly open: () => void;
      }
    | undefined;
};

/**
 * Microphone audio leaves this device only for the environment the person chose in
 * Voice settings. Nothing is inferred from the primary or the draft's environment, and
 * the recording is abandoned the moment that choice changes or its connection drops.
 */
export function useVoiceTranscriptionDestination() {
  const gt = useGT();
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
        ? gt("{provider} via {environment}", {
            provider: CLOUD_SPEECH_LABELS[provider],
            environment: environment.label,
          })
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
  const statusResult = useAtomValue(
    prepared && !cloudProvider ? speechStatusAtom(prepared) : unreadSpeechStatusAtom,
  );
  const refreshStatus = useAtomQueryRunner(speechStatusAtom, {
    refresh: true,
    reportFailure: false,
  });
  const readModels = useAtomCommand(readSpeechModels, { reportFailure: false });
  const setUpModel = useAtomCommand(setUpSpeechModel, { reportFailure: false });
  const cancelModelDownload = useAtomCommand(cancelSpeechModelDownload, { reportFailure: false });
  const [queuedStart, setQueuedStart] = useState<PreparedConnection | null>(null);
  const [setup, setSetup] = useState(INITIAL_SETUP);
  const [previousDestination, setPreviousDestination] = useState({ prepared, grantId });
  const [previousOwner, setPreviousOwner] = useState({
    key: input.ownerKey,
    disabled: input.disabled,
  });
  if (previousDestination.prepared !== prepared || previousDestination.grantId !== grantId) {
    setPreviousDestination({ prepared, grantId });
    setSetup(INITIAL_SETUP);
    setQueuedStart(null);
  }
  if (previousOwner.key !== input.ownerKey || previousOwner.disabled !== input.disabled) {
    setPreviousOwner({ key: input.ownerKey, disabled: input.disabled });
    setQueuedStart(null);
    setSetup(INITIAL_SETUP);
  }

  const session = useRetainedVoiceInputSession({ prepared, grantId, cloudProvider, cloudModel });
  const snapshot = useVoiceInputSessionSnapshot(session);
  const owns = snapshot.target?.ownerKey === input.ownerKey;
  const activity = useVoiceInputSessionActivity(session, input.ownerKey);
  const state: VoiceInputState =
    queuedStart === prepared && prepared ? WAITING_STATE : owns ? snapshot.state : IDLE_VOICE_STATE;
  // One microphone: another draft's recording leaves this editor without voice input until it ends.
  const busyElsewhere = !owns && voiceInputBlocksSubmission(snapshot.state);

  const startRequestRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    ownerKey: string;
    submit: (text: string) => void;
    text?: string;
  } | null>(null);
  const latestRef = useRef({ input, clientSettings, cleanupPrepared, projectWords, session });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed props before an async completion can read them through the session
  useLayoutEffect(() => {
    latestRef.current = { input, clientSettings, cleanupPrepared, projectWords, session };
  });
  const mountedRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons this editor's pending work, and a recording that cannot outlive it, on unmount or a destination change
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      session?.ownerChanged(latestRef.current.input.ownerKey);
    };
  }, [session]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the global indicator this draft is on screen
  useEffect(
    () => (input.presented === false ? undefined : presentVoiceOwner(input.ownerKey)),
    [input.ownerKey, input.presented],
  );

  const currentStatus = Option.getOrNull(AsyncResult.value(statusResult));
  const progress = useAtomValue(
    setup.open && setup.downloading && prepared
      ? speechDownloadProgressAtom(prepared)
      : noSpeechDownloadProgressAtom,
  );
  const setupModelId = setup.model?.id;
  const downloadingModel = AsyncResult.isSuccess(progress)
    ? progress.value.find((candidate) => candidate.id === setupModelId)
    : undefined;
  const setupModel =
    setup.model && downloadingModel
      ? { ...downloadingModel, recommended: setup.model.recommended }
      : setup.model;

  const previousOwnerRef = useRef(input.ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons any queued submission, and a recording that cannot outlive its editor, when the draft's owner changes
  useEffect(() => {
    const previous = previousOwnerRef.current;
    if (previous === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    pendingSubmissionRef.current = null;
    startRequestRef.current += 1;
    if (previous !== input.ownerKey) session?.ownerChanged(previous);
    else if (session?.ownerKey === input.ownerKey) session.cancel();
  }, [input.ownerKey, input.disabled, session]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delivers a queued submission only after the transcript has committed to the draft
  useEffect(() => {
    const pending = pendingSubmissionRef.current;
    if (state.phase === "error") pendingSubmissionRef.current = null;
    if (state.phase !== "idle" || !pending) return;
    pendingSubmissionRef.current = null;
    if (!input.disabled && pending.ownerKey === input.ownerKey && pending.text !== undefined)
      pending.submit(pending.text);
  }, [state, input.ownerKey, input.disabled]);

  const submitAfterDictation = useStableCallback((submit: (text: string) => void) => {
    if (latestRef.current.input.disabled || state.phase === "preparing") return;
    if (!session || !voiceInputBlocksSubmission(state)) {
      submit(latestRef.current.input.readDraft().text);
      return;
    }
    if (pendingSubmissionRef.current) return;
    pendingSubmissionRef.current = { ownerKey: latestRef.current.input.ownerKey, submit };
    if (session.state.phase === "recording") void session.stop();
  });

  const createTarget = useStableCallback((): VoiceInputTarget => {
    const owner = latestRef.current.input.ownerKey;
    const readContext = () => {
      const current = latestRef.current;
      return {
        environmentId: current.input.environmentId,
        projectName: current.input.projectName ?? null,
        projectWords: current.projectWords,
        clientSettings: current.clientSettings,
        cleanup: current.input.cleanup !== false,
        cleanupPrepared: current.cleanupPrepared,
      };
    };
    // Once this editor shows another draft, its environment and cleanup must not see this one.
    const startContext = readContext();
    const persistent = latestRef.current.input.persistentDraft ?? null;
    // While this editor shows the owner, the live editor is the draft; otherwise the stored one.
    const live = () => mountedRef.current && latestRef.current.input.ownerKey === owner;
    return {
      ownerKey: owner,
      label: latestRef.current.input.label ?? null,
      persistent: persistent !== null,
      open: persistent?.open ?? null,
      readDraft: () => {
        if (live()) return latestRef.current.input.readDraft();
        const text = persistent?.readStoredText();
        return text == null ? null : { text, selection: { start: text.length, end: text.length } };
      },
      commitDraft: (text, selection) => {
        if (!live()) {
          persistent?.commitStoredText(text);
          return;
        }
        if (latestRef.current.input.disabled) return;
        latestRef.current.input.commitDraft(text, selection);
        if (pendingSubmissionRef.current?.ownerKey === owner)
          pendingSubmissionRef.current.text = text;
      },
      readContext: () => (live() ? readContext() : startContext),
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a remounted editor takes over its draft's running recording so a queued Send still sees the transcript
  useEffect(() => {
    if (session?.ownerKey === input.ownerKey && voiceInputBlocksSubmission(session.state))
      session.adopt(createTarget());
  }, [session, input.ownerKey, createTarget]);
  const loadSetupCatalog = useStableCallback(
    async (
      connection: PreparedConnection,
      selectedModelId: string,
      benchmarkTier: SpeechBenchmarkTier,
      request: number,
    ) => {
      setSetup({ ...INITIAL_SETUP, open: true });
      const result = await readModels({ prepared: connection, includeBenchmarks: true });
      if (request !== startRequestRef.current) return;
      const catalog = result._tag === "Success" ? result.value : null;
      const choice = chooseSetupSpeechModel(catalog?.models ?? [], {
        selectedModelId,
        intent: latestRef.current.clientSettings.speechLanguage,
        preferred: preferredSpeechLanguages(),
        benchmarkTier,
      });
      setSetup((current) => ({
        ...current,
        model: choice ? { ...choice.model, recommended: choice.recommended } : null,
        language: choice?.language ?? null,
        catalogFailed: catalog === null,
        error: choice
          ? null
          : catalog
            ? m(
                msg(
                  "No model matches your language. Choose a model or change the language in Voice settings.",
                ),
              )
            : m(msg("Could not load transcription models. Check the connection and try again.")),
      }));
    },
  );

  const start = useStableCallback(async () => {
    if (latestRef.current.input.disabled || (setup.open && setup.downloading)) return;
    if (!grantId) {
      if (destination.offerFirstRunSetup && latestRef.current.input.offerSetup !== false)
        await navigate({ to: "/settings/voice", hash: "voice-transcription-destination" });
      return;
    }
    const request = ++startRequestRef.current;
    const owner = latestRef.current.input.ownerKey;
    if (!session || !prepared || busyElsewhere) return;
    if (cloudProvider) {
      await session.start(createTarget());
      return;
    }
    const stillCurrent = () =>
      request === startRequestRef.current &&
      latestRef.current.session === session &&
      latestRef.current.input.ownerKey === owner &&
      !latestRef.current.input.disabled;
    setSetup(INITIAL_SETUP);
    setQueuedStart(prepared);
    const probe = await refreshStatus(prepared);
    if (!stillCurrent()) return;
    setQueuedStart(null);
    if (probe._tag === "Failure") {
      const error = squashAtomCommandFailure(probe);
      toastManager.add({
        type: "error",
        title: m(msg("Could not start voice input")),
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const latestStatus = probe.value;
    if (latestStatus.supported && latestStatus.state === "missing-model") {
      return loadSetupCatalog(prepared, latestStatus.modelId, latestStatus.benchmarkTier, request);
    }
    if (!latestStatus.supported) {
      toastManager.add({
        type: "error",
        title: m(msg("Voice input is not available")),
        description: latestStatus.reason,
      });
      return;
    }
    await session.start(createTarget());
  });

  const downloadSetupModel = useStableCallback(async () => {
    if (!prepared || !currentStatus?.supported || !setupModelId || setup.downloading) return;
    const request = ++startRequestRef.current;
    setSetup((current) => ({ ...current, downloading: true, error: null }));
    const result = await setUpModel({
      prepared,
      modelId: setupModelId,
      selectedModelId: currentStatus.modelId,
      isCurrent: () => request === startRequestRef.current,
    });
    if (request !== startRequestRef.current) return;
    const ready = result._tag === "Success" && result.value.ready;
    setSetup((current) => ({
      ...current,
      downloading: false,
      step: ready ? 1 : current.step,
      error: ready
        ? null
        : result._tag === "Success"
          ? m(msg("The model is not ready. Try downloading it again."))
          : isSpeechModelSelectError(squashAtomCommandFailure(result))
            ? m(msg("The model downloaded, but this environment could not select it. Try again."))
            : m(
                msg(
                  "Could not download the model. Check this environment's connection and try again.",
                ),
              ),
    }));
  });

  const cancelSetupDownload = useStableCallback(async () => {
    if (!prepared || !setupModelId) return;
    startRequestRef.current += 1;
    setSetup((current) => ({ ...current, open: false, downloading: false }));
    const result = await cancelModelDownload({ prepared, modelId: setupModelId });
    if (result._tag === "Success") return;
    const error = squashAtomCommandFailure(result);
    setSetup((current) => ({
      ...current,
      error: error instanceof Error ? error.message : String(error),
    }));
  });

  const destinationReady =
    grantId === null
      ? Boolean(destination.offerFirstRunSetup) && input.offerSetup !== false
      : prepared !== null &&
        (cloudProvider !== undefined ||
          (!AsyncResult.isInitial(statusResult) && currentStatus?.supported !== false));
  return {
    available:
      destinationReady &&
      !busyElsewhere &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
    transcriptionEnvironmentId: destination.environmentId,
    transcriptionEnvironmentLabel: destination.label,
    setup: {
      ...setup,
      model: setupModel,
      setOpen: (open: boolean) => setSetup((current) => ({ ...current, open })),
      retryCatalog:
        setup.open && setup.catalogFailed && prepared && currentStatus?.supported
          ? () =>
              loadSetupCatalog(
                prepared,
                currentStatus.modelId,
                currentStatus.benchmarkTier,
                ++startRequestRef.current,
              )
          : null,
      download: downloadSetupModel,
      cancelDownload: cancelSetupDownload,
      startRecording: async () => {
        setSetup((current) => ({ ...current, open: false }));
        await start();
      },
    },
    state,
    preview:
      state.phase === "recording" || state.phase === "transcribing" ? activity.preview : null,
    level: activity.level,
    recordingStartedAt: owns ? snapshot.recordingStartedAt : null,
    preparing: state.phase === "preparing",
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputBlocksSubmission(state),
    start,
    submitAfterDictation,
    stop: useStableCallback(() => (owns && session ? session.stop() : Promise.resolve())),
    cancel: useStableCallback(() => {
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      setSetup(INITIAL_SETUP);
      if (owns) session?.cancel();
    }),
    skipPostProcessing: useStableCallback(() => {
      if (owns) session?.skipPostProcessing();
    }),
  };
}
