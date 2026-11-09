import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  type EnvironmentId,
  type ProviderInstanceId,
  ProviderRealtimeVoiceError,
  type ProviderSessionId,
  type ProviderThreadId,
  type ProviderRealtimeVoiceStartResult,
  type ThreadId,
} from "@t3tools/contracts";

export interface VoiceOwner {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly threadTitle: string;
  readonly environmentLabel: string;
  readonly accountId: string | null;
}

export interface VoiceOperationOwner extends VoiceOwner {
  readonly operationId: string;
}

export interface VoiceSessionOwnership {
  readonly operationId: string;
  readonly voiceSessionToken: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly expiresAt: string;
}

/** One peer per operation. The sender starts gated shut and carries only gated output, never the
 * raw microphone track. `enableMicrophone` opens the gate; `close` shuts it synchronously before
 * releasing capture, peer and playback, and is never reopened. */
export interface VoiceTransport {
  acquireMicrophone(): Promise<void>;
  createOffer(): Promise<string>;
  setLocalDescription(offer: string): Promise<void>;
  gatherIce(): Promise<void>;
  localSdp(): string;
  setRemoteDescription(sdp: string): Promise<void>;
  isConnected(): boolean;
  enableMicrophone(): void;
  /** Shuts or reopens the gate within the call; playback continues. Absent where unsupported. */
  setMicMuted?(muted: boolean): void;
  /** Attaches or detaches the on-device keyword tap within the call. Absent where unsupported. */
  setKeywords?(on: boolean): void;
  /** Current levels, read on demand by a meter. Absent where unsupported. */
  levels?(): VoiceLevels;
  close(): void;
}

/** RMS of the audio actually sent (after the gate and mute) and of the assistant's audio. */
export interface VoiceLevels {
  readonly input: number;
  readonly output: number;
}
const SILENT: VoiceLevels = { input: 0, output: 0 };

export const VOICE_REPLACEMENT_GATE =
  "Microphone off. The host has not confirmed that this call closed. New calls remain blocked.";
const VOICE_OWNERSHIP_REQUIRED =
  "Microphone off. This host did not return matching voice ownership. Update the T3 host before starting another call.";
const MAX_VOICE_LIFETIME_MS = 4 * 60 * 60 * 1_000;
const LOCAL_LISTENING_UNAVAILABLE = "Paused: local listening unavailable";
/** How long a spoken resume phrase keeps the confirm prompt open. */
const RESUME_ARM_MS = 10_000;
// ponytail: from offline TTS runs, not a real device. One-breath "resume … confirm" chains fired both
// up to 1.92 s apart in detector audio time; calibrate against real speakers and rooms.
const CONFIRM_MIN_GAP_MS = 3_000;
// ponytail: fixed, not measured on real speakers. The call's playback element is gone once paused,
// so this only covers room echo and output latency. Calibrate with a physical speaker test.
const RESUME_ECHO_TAIL_MS = 2_000;
const isVoiceError = Schema.is(ProviderRealtimeVoiceError);
class VoiceOwnershipUnavailable extends Schema.TaggedError<VoiceOwnershipUnavailable>()(
  "VoiceOwnershipUnavailable",
  {},
) {
  override get message(): string {
    return VOICE_OWNERSHIP_REQUIRED;
  }
}
const isOwnershipUnavailable = Schema.is(VoiceOwnershipUnavailable);

type VoiceState = {
  readonly reason: string | null;
  readonly replacementBlocked: boolean;
  readonly expiresAt: string | null;
};
/**
 * On-device keyword listening while paused. "listening": the microphone feeds the local detector
 * only and no call exists. "armed": the resume phrase was heard; the confirm phrase or a trusted
 * Confirm must follow. "unavailable": capture or the detector failed. "off" outside "paused".
 */
export type LocalListening = "off" | "listening" | "armed" | "unavailable";
/** `micMuted`: this device's outbound microphone is muted inside the call. It survives pause,
 * Resume and a move to another conversation, so none of them unmutes silently; ending clears it. */
type LocalState = {
  readonly keywords: boolean;
  readonly listening: LocalListening;
  readonly micMuted: boolean;
};
// What callers publish; the controller adds the local fields from its own state.
type Published = VoiceSnapshot extends infer S
  ? S extends unknown
    ? Omit<S, keyof LocalState>
    : never
  : never;
/**
 * Pause and Stop session revoke the microphone the same way: locally first, then the provider
 * stop. Pause ("pausing" → "paused") keeps the conversation so Resume can start a fresh call in it.
 * Stop session ("ending" → "off") forgets the conversation; nothing can resume it.
 */
export type VoiceSnapshot = VoiceState &
  LocalState &
  (
    | { readonly mode: "off"; readonly owner: null }
    | {
        readonly mode: "connecting" | "transmitting" | "pausing" | "paused" | "ending";
        readonly owner: VoiceOperationOwner;
      }
  );

interface Attempt {
  readonly owner: VoiceOperationOwner;
  readonly generation: number;
  readonly startedAt: number;
  readonly finished: Promise<boolean>;
  readonly resolveFinished: (safe: boolean) => void;
  transport: VoiceTransport | null;
  ownership: VoiceSessionOwnership | null;
  cancelled: boolean;
  remoteRequested: boolean;
  descriptionReady: boolean;
  stopRequested: boolean;
  capturePending: boolean;
  pause: boolean;
  reason: string | null;
  listeningFailed: boolean;
  closedAt: number;
  releaseOwner: (() => void) | null;
  cancelExpiry: (() => void) | null;
  expiresAt: number | null;
}

function readOwnership(
  owner: VoiceOperationOwner,
  result: ProviderRealtimeVoiceStartResult,
): VoiceSessionOwnership {
  if (
    result.operationId !== owner.operationId ||
    !result.voiceSessionToken ||
    result.providerInstanceId === undefined ||
    result.providerThreadId === undefined ||
    result.providerSessionId === undefined ||
    result.expiresAt === undefined ||
    !Number.isFinite(Date.parse(result.expiresAt))
  ) {
    throw new VoiceOwnershipUnavailable({});
  }
  return Object.freeze({
    operationId: result.operationId,
    voiceSessionToken: result.voiceSessionToken,
    providerInstanceId: result.providerInstanceId,
    providerThreadId: result.providerThreadId,
    providerSessionId: result.providerSessionId,
    expiresAt: result.expiresAt,
  });
}

/** The shared mode/generation/owner authority; platform transports enforce local teardown.
 * Paused with keywords on, `localListening` is a separate detector-only capture, stopped before
 * Resume creates the new call. A keyword pause acts at once; a keyword resume only arms, and the
 * spoken confirm phrase resumes only while armed. No remote input can call `resume`. */
export function createRealtimeVoiceController(deps: {
  readonly createTransport: (events: {
    connected(): void;
    failed(reason: string): void;
  }) => VoiceTransport;
  readonly createOperationId: () => string;
  readonly validateOwner: (owner: VoiceOwner) => void;
  readonly startProvider: (
    owner: VoiceOperationOwner,
    sdp: string,
  ) => Promise<ProviderRealtimeVoiceStartResult>;
  readonly stopProvider: (
    owner: VoiceOperationOwner,
    ownership: VoiceSessionOwnership,
  ) => Promise<void>;
  readonly describeError: (error: unknown) => string;
  readonly watchOwner: (owner: VoiceOwner, lost: (reason: string) => void) => () => void;
  readonly now: () => number;
  readonly scheduleExpiry: (expiresAt: number, expired: () => void) => () => void;
  /** Starts and stops the detector-only capture. `start` may throw; that reads as unavailable. */
  readonly localListening?: { start(): void; stop(): void };
  readonly keywordsEnabled?: boolean;
}) {
  let keywords = deps.keywordsEnabled === true && deps.localListening !== undefined;
  let listening: LocalListening = "off";
  let micMuted = false;
  let pausedAt = 0;
  let armedAt = 0;
  let armedHeardAt = 0;
  let cancelArm: (() => void) | null = null;
  let snapshot: VoiceSnapshot = {
    mode: "off",
    owner: null,
    reason: null,
    replacementBlocked: false,
    expiresAt: null,
    keywords,
    listening,
    micMuted,
  };
  let generation = 0;
  let attempt: Attempt | null = null;
  let moveIntent: object | null = null;
  const listeners = new Set<() => void>();
  const clearArm = () => {
    cancelArm?.();
    cancelArm = null;
  };
  const stopListening = () => {
    clearArm();
    if (listening === "listening" || listening === "armed") deps.localListening?.stop();
    listening = "off";
  };
  // Every exit from "paused" passes here, so the detector's capture never outlives it.
  const publish = (next: Published) => {
    if (next.mode !== "paused") stopListening();
    if (next.mode === "off") micMuted = false;
    snapshot = { ...next, keywords, listening, micMuted };
    for (const listener of listeners) listener();
  };
  const republish = () => publish(snapshot);
  // Only from "paused": the call's capture is already closed, so this is a fresh, separate one.
  const startListening = () => {
    const active = listening === "listening" || listening === "armed";
    if (!keywords || deps.localListening === undefined || active) return;
    try {
      deps.localListening.start();
      listening = "listening";
    } catch {
      deps.localListening.stop();
      listening = "unavailable";
    }
  };
  const current = (value: Attempt) =>
    attempt === value && !value.cancelled && value.generation === generation;
  const releaseOwner = (value: Attempt) => {
    const release = value.releaseOwner;
    value.releaseOwner = null;
    release?.();
  };
  const finish = (value: Attempt, safe: boolean) => {
    if (attempt !== value) return;
    value.cancelExpiry?.();
    value.cancelExpiry = null;
    releaseOwner(value);
    attempt = null;
    const state = { reason: value.reason, replacementBlocked: !safe, expiresAt: null };
    if (value.pause) {
      pausedAt = value.closedAt;
      publish({ ...state, mode: "paused", owner: value.owner });
      if (value.listeningFailed) listening = "unavailable";
      else startListening();
      if (listening !== "off") republish();
    } else publish({ ...state, mode: "off", owner: null });
    value.resolveFinished(safe);
  };
  const stopRemote = async (value: Attempt) => {
    if (value.stopRequested || value.ownership === null) return;
    value.stopRequested = true;
    try {
      // Modern stop only succeeds after the host's native-close barrier, not merely a stop request ack.
      await deps.stopProvider(value.owner, value.ownership);
      finish(value, true);
    } catch (error) {
      value.reason = [value.reason, VOICE_REPLACEMENT_GATE, deps.describeError(error)]
        .filter(Boolean)
        .join(" ");
      finish(value, false);
    }
  };
  const cancelAttempt = (reason: string | null = null, pause = false) => {
    const value = attempt;
    if (value === null || value.cancelled) return;
    value.cancelled = true;
    value.pause = pause;
    value.reason = reason;
    value.closedAt = deps.now();
    generation += 1;
    // Local capture and playback stop before entering the serialized RPC queue.
    value.transport?.close();
    value.cancelExpiry?.();
    value.cancelExpiry = null;
    publish({
      mode: pause ? "pausing" : "ending",
      owner: value.owner,
      reason,
      replacementBlocked: value.remoteRequested,
      expiresAt: snapshot.expiresAt,
    });
    if (!value.remoteRequested && !value.capturePending) finish(value, true);
    else if (value.ownership !== null) void stopRemote(value);
  };
  /** Stop session. Overrides a pending pause and forgets a paused conversation. */
  const end = (reason: string | null = null) => {
    moveIntent = null;
    stopListening();
    const value = attempt;
    if (value === null) {
      if (snapshot.mode === "paused") {
        publish({
          mode: "off",
          owner: null,
          // A blocked replacement keeps explaining why new calls stay blocked.
          reason: reason ?? (snapshot.replacementBlocked ? snapshot.reason : null),
          replacementBlocked: snapshot.replacementBlocked,
          expiresAt: null,
        });
      }
      return;
    }
    if (!value.cancelled) {
      cancelAttempt(reason);
      return;
    }
    const nextReason = value.reason ?? reason;
    if (!value.pause && nextReason === value.reason) return;
    value.pause = false;
    value.reason = nextReason;
    publish({
      mode: "ending",
      owner: value.owner,
      reason: nextReason,
      replacementBlocked: snapshot.replacementBlocked,
      expiresAt: snapshot.expiresAt,
    });
  };
  /** Privacy pause. Revokes like Stop session, then lands in "paused" once the provider stop settles.
   * Already paused, it cancels an armed resume: the spoken pause phrase is also the spoken cancel. */
  const pause = (reason: string | null = null) => {
    moveIntent = null;
    if (attempt === null && snapshot.mode === "paused") cancelResume();
    else cancelAttempt(reason, true);
  };
  const markConnected = (value: Attempt) => {
    if (!current(value) || !value.descriptionReady || !value.transport?.isConnected()) return;
    if (value.expiresAt === null || deps.now() >= value.expiresAt) {
      end("Voice reached its time limit. Start a new call explicitly.");
      return;
    }
    value.transport.enableMicrophone();
    publish({
      mode: "transmitting",
      owner: value.owner,
      reason: null,
      replacementBlocked: false,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(value.expiresAt)),
    });
  };
  const begin = async (owner: VoiceOwner, muted: boolean) => {
    if (attempt !== null || snapshot.replacementBlocked) return;
    deps.validateOwner(owner);
    micMuted = muted;
    const operationId = deps.createOperationId();
    let resolveFinished: (safe: boolean) => void = () => {};
    const finished = new Promise<boolean>((resolve) => {
      resolveFinished = resolve;
    });
    const value: Attempt = {
      owner: Object.freeze({ ...owner, operationId }),
      generation: ++generation,
      startedAt: deps.now(),
      finished,
      resolveFinished,
      transport: null,
      ownership: null,
      cancelled: false,
      remoteRequested: false,
      descriptionReady: false,
      stopRequested: false,
      capturePending: false,
      pause: false,
      reason: null,
      listeningFailed: false,
      closedAt: 0,
      releaseOwner: null,
      cancelExpiry: null,
      expiresAt: null,
    };
    attempt = value;
    publish({
      mode: "connecting",
      owner: value.owner,
      reason: null,
      replacementBlocked: false,
      expiresAt: null,
    });
    try {
      value.releaseOwner = deps.watchOwner(value.owner, (reason) => {
        if (attempt === value) end(reason);
      });
      if (!current(value)) {
        releaseOwner(value);
        return;
      }
      const transport = deps.createTransport({
        connected: () => markConnected(value),
        failed: (reason) => {
          if (current(value)) end(reason);
        },
      });
      value.transport = transport;
      // Before the gate can open, so a muted Resume or move never sends a frame.
      if (micMuted) transport.setMicMuted?.(true);
      value.capturePending = true;
      try {
        await transport.acquireMicrophone();
      } finally {
        value.capturePending = false;
      }
      if (!current(value)) return;
      const offer = await transport.createOffer();
      if (!current(value)) return;
      await transport.setLocalDescription(offer);
      if (!current(value)) return;
      await transport.gatherIce();
      if (!current(value)) return;
      const offerSdp = transport.localSdp();
      value.remoteRequested = true;
      const result = await deps.startProvider(value.owner, offerSdp);
      if (attempt !== value) return;
      value.ownership = readOwnership(value.owner, result);
      if (
        value.ownership.providerInstanceId !== value.owner.providerInstanceId ||
        value.ownership.providerThreadId !== value.owner.providerThreadId ||
        value.ownership.providerSessionId !== value.owner.providerSessionId
      ) {
        // This operation owns the returned binding for cleanup, but cannot authorize its audio.
        end(
          value.reason ??
            "Microphone off. The conversation's provider changed during voice startup.",
        );
        void stopRemote(value);
        return;
      }
      if (!current(value)) {
        void stopRemote(value);
        return;
      }
      value.expiresAt = Math.min(
        Date.parse(value.ownership.expiresAt),
        value.startedAt + MAX_VOICE_LIFETIME_MS,
      );
      if (deps.now() >= value.expiresAt) {
        end("Voice reached its time limit. Start a new call explicitly.");
        return;
      }
      publish({
        mode: "connecting",
        owner: value.owner,
        reason: null,
        replacementBlocked: false,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(value.expiresAt)),
      });
      if (!current(value)) return;
      value.cancelExpiry = deps.scheduleExpiry(value.expiresAt, () => {
        if (current(value)) end("Voice reached its time limit. Start a new call explicitly.");
      });
      await transport.setRemoteDescription(result.sdp);
      if (!current(value)) return;
      value.descriptionReady = true;
      markConnected(value);
    } catch (error) {
      if (attempt !== value) return;
      if (!value.cancelled) cancelAttempt(deps.describeError(error));
      // Missing/mismatched ownership and ambiguous start failure never authorize a legacy stop.
      if (value.ownership === null) {
        // A host refusal before reaching the provider cannot leave a call open.
        const unstarted =
          !value.remoteRequested || (isVoiceError(error) && error.refusedBeforeStart === true);
        if (!unstarted)
          value.reason = isOwnershipUnavailable(error)
            ? VOICE_OWNERSHIP_REQUIRED
            : `${VOICE_REPLACEMENT_GATE} ${deps.describeError(error)}`;
        finish(value, unstarted);
      }
    } finally {
      // getUserMedia cannot be aborted. Its reservation lasts until the late stream is stopped.
      if (value.cancelled && !value.remoteRequested) finish(value, true);
    }
  };
  const start = (owner: VoiceOwner) => begin(owner, false);
  const move = async (owner: VoiceOwner) => {
    deps.validateOwner(owner);
    if (
      snapshot.replacementBlocked ||
      moveIntent !== null ||
      snapshot.mode === "ending" ||
      snapshot.mode === "pausing"
    )
      return;
    const source = attempt;
    if (source === null) {
      await start(owner);
      return;
    }
    if (
      source.owner.environmentId === owner.environmentId &&
      source.owner.threadId === owner.threadId
    )
      return;
    const destination = Object.freeze({ ...owner });
    const muted = snapshot.micMuted;
    const intent = {};
    moveIntent = intent;
    cancelAttempt();
    const safe = await source.finished;
    if (moveIntent !== intent) return;
    moveIntent = null;
    if (!safe || attempt !== null || snapshot.replacementBlocked) return;
    // Grants and destination provider identity may change while A's native-close barrier settles.
    deps.validateOwner(destination);
    await begin(destination, muted);
  };
  /**
   * The only way out of pause, from a trusted local action or a confirmed spoken resume
   * (`spokenConfirm`): a new operation, peer and microphone grant for the paused conversation.
   * Nothing captured before or during the pause survives into it. Pass a freshly read owner; a
   * failed check leaves voice paused.
   */
  const resume = async (owner: VoiceOwner) => {
    if (
      snapshot.mode !== "paused" ||
      snapshot.owner.environmentId !== owner.environmentId ||
      snapshot.owner.threadId !== owner.threadId
    )
      return;
    // Release the detector's capture first: the new call acquires its own microphone afterwards.
    stopListening();
    try {
      await begin(owner, snapshot.micMuted);
    } finally {
      // A refused start (blocked replacement, failed owner check) leaves voice paused.
      if (attempt === null && snapshot.mode === "paused") {
        startListening();
        republish();
      }
    }
  };
  /** The spoken resume phrase. Opens only the local confirm prompt, and expires on its own.
   * `heardAt` is the detector's audio time of the phrase, the clock `spokenConfirm`'s gap uses. */
  const armResume = (heardAt: number) => {
    if (snapshot.mode !== "paused" || listening !== "listening") return;
    // Ignore the room's echo of the assistant's last words after the call closed.
    if (deps.now() < pausedAt + RESUME_ECHO_TAIL_MS) return;
    listening = "armed";
    armedAt = deps.now();
    armedHeardAt = heardAt;
    cancelArm = deps.scheduleExpiry(armedAt + RESUME_ARM_MS, () => cancelResume());
    republish();
  };
  /**
   * The spoken confirm phrase: resumes only while armed, at least CONFIRM_MIN_GAP_MS of detector
   * audio after the arm (so a worker backlog cannot stretch one utterance past it) and before the
   * wall-clock deadline. Anywhere else it does nothing and nothing is queued. Pass a freshly read
   * owner, as for `resume`; a refused start lands back in "listening" and needs a new arm.
   */
  const spokenConfirm = async (owner: VoiceOwner, heardAt: number) => {
    if (snapshot.mode !== "paused" || attempt !== null || listening !== "armed") return;
    if (heardAt < armedHeardAt + CONFIRM_MIN_GAP_MS || deps.now() > armedAt + RESUME_ARM_MS) return;
    await resume(owner);
  };
  const cancelResume = () => {
    if (listening !== "armed") return;
    clearArm();
    listening = "listening";
    republish();
  };
  /** Capture or detector failure. Never resumes; a live call pauses so no keyword is relied on. */
  const localListeningFailed = () => {
    const value = attempt;
    if (snapshot.mode === "paused" && value === null) {
      if (listening === "off" || listening === "unavailable") return;
      stopListening();
      listening = "unavailable";
      republish();
    } else if (value !== null) {
      value.listeningFailed = true;
      if (!value.cancelled) pause(LOCAL_LISTENING_UNAVAILABLE);
    }
  };
  /** Mute only inside a transmitting call whose transport supports it; anything else is refused. */
  const setMicMuted = (muted: boolean) => {
    const value = attempt;
    if (snapshot.mode !== "transmitting" || value === null || !current(value)) return;
    if (value.transport?.setMicMuted === undefined || muted === micMuted) return;
    value.transport.setMicMuted(muted);
    micMuted = muted;
    republish();
  };
  /** Poll it from a meter; levels never go through `subscribe`. Zero outside a live call. */
  const levels = (): VoiceLevels => {
    const value = attempt;
    if (snapshot.mode !== "transmitting" || value === null || !current(value)) return SILENT;
    return value.transport?.levels?.() ?? SILENT;
  };
  /** Takes effect at once: paused, it starts or stops the detector-only capture; in a call, the
   * transport attaches or detaches its keyword tap. Mute, pause and the gate are untouched. */
  const setKeywords = (enabled: boolean) => {
    keywords = enabled && deps.localListening !== undefined;
    if (snapshot.mode === "paused" && attempt === null) {
      if (keywords) startListening();
      else stopListening();
    } else attempt?.transport?.setKeywords?.(keywords);
    republish();
  };
  return {
    start,
    move,
    end,
    pause,
    resume,
    armResume,
    spokenConfirm,
    cancelResume,
    localListeningFailed,
    setKeywords,
    setMicMuted,
    levels,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type RealtimeVoiceController = ReturnType<typeof createRealtimeVoiceController>;
