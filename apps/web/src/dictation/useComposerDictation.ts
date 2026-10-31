import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useNavigate } from "@tanstack/react-router";
import { use, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { toastManager } from "../components/ui/toast";
import {
  dictationEnvironment,
  useDictationEnvironmentId,
  useDictationState,
} from "../state/dictation";
import { createStreamingDictation } from "./streamingDictation";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

type DraftSelection = { readonly start: number; readonly end: number };

type ComposerDictationInput = Parameters<typeof useComposerDictation>[0] & {
  readonly environmentId: EnvironmentId | null;
};

/** Wires a controller to the composer's latest input, read when callbacks run. */
function createComposerDictationController(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly readLatest: () => ComposerDictationInput;
  readonly markCommitted: () => void;
  readonly setState: (state: VoiceInputState) => void;
}) {
  const { readLatest, markCommitted } = input;
  let controller: VoiceInputController | null = null;
  const streaming = createStreamingDictation({
    registry: input.registry,
    resolveEnvironmentId: () => readLatest().environmentId,
    interrupt: (message) => void controller?.interruptRecording(message),
    rewriteTranscript: (text) => readLatest().rewriteTranscript(text),
    finishedAtLimit: (uri) =>
      void controller?.handleRecorderStatus({
        isFinished: true,
        hasError: false,
        error: null,
        url: uri,
      }),
  });
  const created = new VoiceInputController({
    ...streaming.dependencies,
    readDraft: () => {
      const draft = readLatest().readDraft();
      return draft && { ...draft, ownerKey: readLatest().ownerKey, revision: 0 };
    },
    commitDraft: (text, selection, inserted) => {
      markCommitted();
      readLatest().commitDraft(text, selection, inserted);
    },
    // Render first, so the UI follows the controller even if cleanup throws.
    onStateChange: (next) => {
      input.setState(next);
      streaming.settle(next);
    },
  });
  controller = created;
  return { controller: created, level: streaming.level, capturedAudio: streaming.capturedAudio };
}

/**
 * Dictation for one composer. Audio streams to the environment picked by
 * `useDictationEnvironmentId`, and the transcript lands at the selection the
 * draft had when recording started. The draft is frozen while `active`, so the
 * composer should block submission and editing until it clears.
 */
export function useComposerDictation(input: {
  /** Identifies the text being dictated into; a change cancels a running dictation. */
  readonly ownerKey: string;
  readonly draftEnvironmentId: EnvironmentId | null;
  readonly readDraft: () => { readonly text: string; readonly selection: DraftSelection } | null;
  /** `inserted` is where the transcript landed in `text`. */
  readonly commitDraft: (text: string, selection: DraftSelection, inserted: DraftSelection) => void;
  /** Applied to the transcript before insertion; read when the transcript arrives. */
  readonly rewriteTranscript: (text: string) => string;
  /** Runs once the editor is unfrozen after a transcript was inserted. */
  readonly onCommitted: () => void;
}) {
  const registry = use(RegistryContext);
  const navigate = useNavigate();
  const environmentId = useDictationEnvironmentId(input.draftEnvironmentId);
  const { state: environmentState } = useDictationState(environmentId);
  const modelLoaded = environmentState?.loadedModel != null;
  const latest = useRef({ ...input, environmentId, modelLoaded });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh controller callbacks after React commits the current draft.
  useLayoutEffect(() => {
    latest.current = { ...input, environmentId, modelLoaded };
  });
  const committed = useRef(false);
  const [state, setState] = useState(IDLE_STATE);

  const readLatest = useStableCallback(() => latest.current);
  const markCommitted = useStableCallback(() => {
    committed.current = true;
  });
  const [{ controller, level, capturedAudio }] = useState(() =>
    createComposerDictationController({ registry, readLatest, markCommitted, setState }),
  );

  const ownerKey = useRef(input.ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel the external recording controller when its draft owner changes.
  useEffect(() => {
    if (ownerKey.current === input.ownerKey) return;
    ownerKey.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the external recording controller on unmount.
  useEffect(() => () => controller.dispose(), [controller]);

  // The editor is enabled again by the time this parent effect runs.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore editor focus and selection after the controller commits its transcript.
  useEffect(() => {
    if (state.phase !== "idle" || !committed.current) return;
    committed.current = false;
    latest.current.onCommitted();
  }, [state.phase]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Report external recording failures through the toast manager.
  useEffect(() => {
    if (state.phase !== "error" || state.error === null) return;
    toastManager.add({ type: "error", title: state.error });
    controller.cancel();
  }, [controller, state]);

  // Stable across renders so callers can run it from an effect keyed only on focus.
  const warm = useStableCallback(() => {
    const { environmentId: target, modelLoaded: loaded } = latest.current;
    if (target === null || loaded) return;
    void runAtomCommand(
      registry,
      dictationEnvironment.warm,
      { environmentId: target, input: {} },
      { reportFailure: false },
    );
  });

  const openSettings = () =>
    void navigate({
      to: "/settings/devices",
      hash: "dictation",
      search: { machine: latest.current.draftEnvironmentId ?? undefined },
      state: { settingsTargetHighlight: true },
    });

  return {
    state,
    environmentId,
    /** Microphone level for recording visuals; subscribe instead of rendering it. */
    level,
    /** True while dictation can still change the draft. */
    active: voiceInputBlocksSubmission(state),
    /** The controller's phase right now, ahead of the next render. */
    readPhase: () => controller.currentState.phase,
    /** True once this dictation has captured audio, which starts before recording does. */
    capturedAudio,
    /** Starts recording, or opens Dictation settings when no environment can transcribe. */
    start: () => {
      if (latest.current.environmentId === null) {
        openSettings();
        return;
      }
      void controller.start();
    },
    /**
     * Starts loading the speech model if it is not loaded yet, so a dictation
     * that follows soon does not wait for it. Call when the composer gains focus.
     */
    warm,
    /** Stops recording and inserts the transcript; while preparing, as soon as recording starts. */
    stop: () => void controller.stop(),
    cancel: () => controller.cancel(),
  };
}

export type ComposerDictation = ReturnType<typeof useComposerDictation>;
