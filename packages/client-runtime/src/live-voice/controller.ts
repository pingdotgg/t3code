export interface LiveVoiceTranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface LiveVoiceState {
  status: "idle" | "connecting" | "connected" | "error";
  muted: boolean;
  error: string | null;
  transcript: LiveVoiceTranscriptEntry[];
}

export interface LiveVoiceTransportCallbacks {
  onEvent(data: unknown): void;
  onConnectionState(state: "connected" | "failed" | "disconnected" | "closed"): void;
}

export interface LiveVoiceTransport {
  createOffer(): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  setMuted(muted: boolean): void;
  close(): void;
}

export interface LiveVoiceControllerDependencies {
  createTransport(
    callbacks: LiveVoiceTransportCallbacks,
  ): LiveVoiceTransport | Promise<LiveVoiceTransport>;
  startSession(input: { sdp: string; signal: AbortSignal }): Promise<{
    sessionId: string;
    sdp: string;
  }>;
  stopSession(sessionId: string): Promise<void>;
  onStateChange(state: LiveVoiceState): void;
}

export interface LiveVoiceController {
  start(): Promise<void>;
  stop(): Promise<void>;
  setMuted(muted: boolean): void;
  dispose(): Promise<void>;
  getState(): LiveVoiceState;
}

const MAX_TRANSCRIPT_ENTRIES = 100;
const MAX_TRANSCRIPT_CHARACTERS = 24_000;
const MAX_REMEMBERED_EVENTS = 1_000;

interface Attempt {
  abort: AbortController;
  transport: LiveVoiceTransport | null;
  sessionId: string | null;
  remoteStop: Promise<void> | null;
  task: Promise<void>;
  eventIds: Set<string>;
  connectionTimeout: ReturnType<typeof setTimeout> | null;
  peerConnected: boolean;
  sessionStarted: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The voice connection failed. Please try again.";
}

/** Owns one call; stale transport callbacks and late session creation cannot revive it. */
export function createLiveVoiceController(
  dependencies: LiveVoiceControllerDependencies,
): LiveVoiceController {
  let state: LiveVoiceState = { status: "idle", muted: false, error: null, transcript: [] };
  let active: Attempt | null = null;
  let retiring: Promise<void> | null = null;
  let restartRequest = 0;
  let disposed = false;

  const snapshot = (): LiveVoiceState => ({
    ...state,
    transcript: state.transcript.map((entry) => ({ ...entry })),
  });
  const update = (patch: Partial<LiveVoiceState>) => {
    state = { ...state, ...patch };
    if (!disposed) dependencies.onStateChange(snapshot());
  };
  const isCurrent = (attempt: Attempt) => active === attempt && !attempt.abort.signal.aborted;

  const cleanup = async (attempt: Attempt) => {
    if (attempt.connectionTimeout !== null) clearTimeout(attempt.connectionTimeout);
    attempt.connectionTimeout = null;
    const transport = attempt.transport;
    attempt.transport = null;
    // Closing can synchronously emit connection callbacks, so detach the attempt first.
    try {
      transport?.close();
    } finally {
      if (attempt.sessionId !== null && attempt.remoteStop === null) {
        const sessionId = attempt.sessionId;
        attempt.remoteStop = Promise.resolve().then(() => dependencies.stopSession(sessionId));
      }
      await attempt.remoteStop;
    }
  };

  const retire = (attempt: Attempt, patch: Partial<LiveVoiceState>) => {
    active = null;
    attempt.abort.abort();
    // Keep ownership until non-abortable permission/HTTP work returns and its resources close.
    // Media closes synchronously; remote cleanup may continue while the UI is idle.
    const cleaning = cleanup(attempt).catch((error: unknown) => {
      if (!disposed && patch.status !== "error") update({ status: "error", error: message(error) });
    });
    const retirement = Promise.all([attempt.task, cleaning])
      .then(() => cleanup(attempt))
      .catch(() => undefined)
      .finally(() => {
        if (retiring === retirement) retiring = null;
      });
    retiring = retirement;
    update(patch);
    return retirement;
  };

  const fail = (attempt: Attempt, error: string) => {
    if (isCurrent(attempt)) void retire(attempt, { status: "error", error });
  };

  const markReady = (attempt: Attempt) => {
    if (!attempt.peerConnected || !attempt.sessionStarted) return;
    if (attempt.connectionTimeout !== null) clearTimeout(attempt.connectionTimeout);
    attempt.connectionTimeout = null;
    update({ status: "connected", error: null });
  };

  const appendTranscript = (role: LiveVoiceTranscriptEntry["role"], delta: string) => {
    if (!delta) return;
    const transcript = state.transcript.map((entry) => ({ ...entry }));
    const last = transcript[transcript.length - 1];
    if (last?.role === role) last.text += delta;
    else transcript.push({ role, text: delta });
    if (transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
    let excess =
      transcript.reduce((length, entry) => length + entry.text.length, 0) -
      MAX_TRANSCRIPT_CHARACTERS;
    while (excess > 0 && transcript.length > 0) {
      const first = transcript[0]!;
      if (first.text.length <= excess) {
        excess -= first.text.length;
        transcript.shift();
      } else {
        first.text = first.text.slice(excess);
        excess = 0;
      }
    }
    update({ transcript });
  };

  const onEvent = (attempt: Attempt, data: unknown) => {
    if (!isCurrent(attempt)) return;
    const event = record(data);
    if (!event) return;
    if (typeof event.event_id === "string") {
      if (attempt.eventIds.has(event.event_id)) return;
      attempt.eventIds.add(event.event_id);
      if (attempt.eventIds.size > MAX_REMEMBERED_EVENTS) {
        const oldest = attempt.eventIds.values().next().value;
        if (oldest !== undefined) attempt.eventIds.delete(oldest);
      }
    }
    if (event.type === "error") {
      const error = record(event.error);
      fail(
        attempt,
        typeof error?.message === "string" ? error.message : "The voice session failed.",
      );
    } else if (event.type === "session.closed") {
      void retire(attempt, { status: "idle", error: null });
    } else if (event.type === "session.started") {
      attempt.sessionStarted = true;
      markReady(attempt);
    } else if (typeof event.delta === "string") {
      if (event.type === "session.input_transcript.delta") appendTranscript("user", event.delta);
      else if (event.type === "session.output_transcript.delta")
        appendTranscript("assistant", event.delta);
    }
  };

  const stop = async () => {
    restartRequest++;
    const attempt = active;
    if (!attempt) return retiring ?? undefined;
    await retire(attempt, { status: "idle", error: null });
  };

  const controller: LiveVoiceController = {
    start() {
      if (disposed) return Promise.resolve();
      if (active) return active.task;
      if (retiring) {
        const request = ++restartRequest;
        return retiring.then(() => (request === restartRequest ? controller.start() : undefined));
      }
      const attempt: Attempt = {
        abort: new AbortController(),
        transport: null,
        sessionId: null,
        remoteStop: null,
        task: Promise.resolve(),
        eventIds: new Set(),
        connectionTimeout: null,
        peerConnected: false,
        sessionStarted: false,
      };
      active = attempt;
      update({ status: "connecting", error: null, transcript: [] });
      // This callback-based media controller owns and clears its deadline outside Effect fibers.
      // @effect-diagnostics-next-line globalTimers:off
      attempt.connectionTimeout = setTimeout(() => {
        fail(attempt, "The voice connection timed out. Please try again.");
      }, 30_000);
      attempt.task = Promise.resolve().then(async () => {
        try {
          if (!isCurrent(attempt)) return;
          attempt.transport = await dependencies.createTransport({
            onEvent: (data) => onEvent(attempt, data),
            onConnectionState: (connection) => {
              if (!isCurrent(attempt)) return;
              if (connection === "connected") {
                attempt.peerConnected = true;
                markReady(attempt);
              } else fail(attempt, "The voice connection ended. Please reconnect.");
            },
          });
          if (!isCurrent(attempt)) return;
          attempt.transport.setMuted(state.muted);
          const sdp = await attempt.transport.createOffer();
          if (!isCurrent(attempt)) return;
          const session = await dependencies.startSession({ sdp, signal: attempt.abort.signal });
          attempt.sessionId = session.sessionId;
          if (!isCurrent(attempt)) return;
          await attempt.transport!.acceptAnswer(session.sdp);
        } catch (error) {
          fail(attempt, message(error));
        } finally {
          if (!isCurrent(attempt)) await cleanup(attempt).catch(() => undefined);
        }
      });
      return attempt.task;
    },
    stop,
    setMuted(muted) {
      if (disposed) return;
      update({ muted });
      const attempt = active;
      try {
        attempt?.transport?.setMuted(muted);
      } catch (error) {
        if (attempt) fail(attempt, message(error));
      }
    },
    async dispose() {
      disposed = true;
      await stop();
    },
    getState: snapshot,
  };
  return controller;
}
