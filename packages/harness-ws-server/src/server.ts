import type {
  HarnessEvent,
  HarnessNativeFrame,
  HarnessProfile,
  HarnessSession,
  HarnessSessionId,
  HarnessSnapshot,
} from "@t3tools/contracts";
import { EventId, HarnessSessionId as HarnessSessionIdSchema } from "@t3tools/contracts";
import type {
  HarnessAdapter,
  HarnessResolveElicitationInput,
  HarnessResolvePermissionInput,
  HarnessSendTurnInput,
  HarnessUpdateSessionConfigInput,
} from "./adapters";
import { HarnessAdapterError } from "./adapters";
import { HarnessMemoryStore } from "./storage";

interface LiveSessionState {
  readonly adapter: HarnessAdapter;
  readonly profile: HarnessProfile;
  session: HarnessSession;
  streamAbort?: AbortController;
}

export interface HarnessServiceOptions {
  readonly adapters: ReadonlyArray<HarnessAdapter>;
  readonly store?: HarnessMemoryStore;
  readonly now?: () => string;
}

export type HarnessEventListener = (event: HarnessEvent, snapshot: HarnessSnapshot) => void;

function asSessionKey(sessionId: HarnessSessionId): string {
  return String(sessionId);
}

function findProfile(snapshot: HarnessSnapshot, profileId: HarnessProfile["id"]): HarnessProfile {
  const profile = snapshot.profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new HarnessAdapterError(`Unknown harness profile '${profileId}'.`);
  }
  return profile;
}

function createEventId(prefix: string, sessionId: HarnessSessionId, sequence: number) {
  return EventId.makeUnsafe(`${prefix}:${sessionId}:${sequence}`);
}

function buildSessionCreatedEvent(
  session: HarnessSession,
  sequence: number,
  createdAt: string,
): HarnessEvent {
  return {
    eventId: createEventId("harness-session-created", session.id, sequence),
    sessionId: session.id,
    createdAt,
    sequence,
    harness: session.harness,
    adapterKey: session.adapterKey,
    connectionMode: session.connectionMode,
    type: "session.created",
    payload: {
      ...(session.profileId ? { profileId: String(session.profileId) } : {}),
      ...(session.title ? { title: session.title } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.mode ? { mode: session.mode } : {}),
      state: session.state,
      capabilities: session.capabilities,
      ...(session.metadata ? { metadata: session.metadata } : {}),
    },
  };
}

function buildSessionBoundEvent(
  session: HarnessSession,
  profile: HarnessProfile,
  sequence: number,
  createdAt: string,
): HarnessEvent | undefined {
  if (!session.nativeSessionId) {
    return undefined;
  }
  return {
    eventId: createEventId("harness-session-bound", session.id, sequence),
    sessionId: session.id,
    createdAt,
    sequence,
    harness: session.harness,
    adapterKey: session.adapterKey,
    connectionMode: session.connectionMode,
    type: "session.bound",
    payload: {
      binding: {
        sessionId: session.id,
        profileId: profile.id,
        harness: session.harness,
        adapterKey: session.adapterKey,
        connectionMode: session.connectionMode,
        nativeSessionId: session.nativeSessionId,
        ...(session.activeTurnId ? { nativeTurnId: session.activeTurnId } : {}),
        ...(session.metadata ? { metadata: session.metadata } : {}),
        createdAt,
        updatedAt: createdAt,
      },
    },
  };
}

function buildAttachedSession(profile: HarnessProfile, adapter: HarnessAdapter, now: string): HarnessSession {
  return {
    id: HarnessSessionIdSchema.makeUnsafe(`attached:${profile.id}:${now}`),
    profileId: profile.id,
    harness: profile.harness,
    adapterKey: adapter.key,
    connectionMode: "attached",
    title: `${profile.name} Attached Session`,
    cwd:
      profile.harness === "codex-app-server"
        ? profile.config.codexAppServer?.cwd ?? null
        : profile.harness === "claude-agent-sdk"
          ? profile.config.claudeAgentSdk?.cwd ?? null
          : profile.config.opencode?.directory ?? null,
    model: null,
    mode:
      profile.harness === "claude-agent-sdk"
        ? profile.config.claudeAgentSdk?.sessionMode ?? null
        : null,
    state: "idle",
    activeTurnId: null,
    nativeSessionId: null,
    lastError: null,
    capabilities: adapter.capabilities,
    metadata: {
      attached: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export class HarnessService {
  readonly #store: HarnessMemoryStore;
  readonly #adapters = new Map<string, HarnessAdapter>();
  readonly #listeners = new Set<HarnessEventListener>();
  readonly #liveSessions = new Map<string, LiveSessionState>();
  readonly #now: () => string;

  constructor(options: HarnessServiceOptions) {
    this.#store = options.store ?? new HarnessMemoryStore();
    this.#now = options.now ?? (() => new Date().toISOString());
    for (const adapter of options.adapters) {
      this.#adapters.set(adapter.harness, adapter);
    }
  }

  listProfiles(): ReadonlyArray<HarnessProfile> {
    return this.#store.listProfiles();
  }

  upsertProfile(profile: HarnessProfile): HarnessProfile {
    const adapter = this.#resolveAdapter(profile.harness);
    adapter.validateProfile(profile);
    return this.#store.upsertProfile(profile);
  }

  deleteProfile(profileId: HarnessProfile["id"]): boolean {
    return this.#store.deleteProfile(String(profileId));
  }

  listSessions(): ReadonlyArray<HarnessSession> {
    return this.#store.getSnapshot().sessions;
  }

  getSnapshot(): HarnessSnapshot {
    return this.#store.getSnapshot();
  }

  replayEvents(sessionId: HarnessSessionId, fromSequence = 0): ReadonlyArray<HarnessEvent> {
    return this.#store.listEvents(sessionId, fromSequence);
  }

  getNativeFrames(sessionId: HarnessSessionId): ReadonlyArray<HarnessNativeFrame> {
    return this.#store.listNativeFrames(sessionId);
  }

  subscribe(listener: HarnessEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async createSession(profileId: HarnessProfile["id"], title?: string): Promise<HarnessSession> {
    const snapshot = this.#store.getSnapshot();
    const profile = findProfile(snapshot, profileId);
    const adapter = this.#resolveAdapter(profile.harness);
    const session = await adapter.createSession({
      profile,
      ...(title !== undefined ? { title } : {}),
    });
    this.#registerLiveSession(profile, adapter, session);
    this.#publish(buildSessionCreatedEvent(session, this.#nextSequence(), this.#now()));
    const bindingEvent = buildSessionBoundEvent(session, profile, this.#nextSequence(), this.#now());
    if (bindingEvent) {
      this.#publish(bindingEvent);
    }
    this.#startStreaming(asSessionKey(session.id));
    return this.#requireSession(session.id);
  }

  async attachSession(profileId: HarnessProfile["id"]): Promise<HarnessSession> {
    const snapshot = this.#store.getSnapshot();
    const profile = findProfile(snapshot, profileId);
    const adapter = this.#resolveAdapter(profile.harness);
    const session = buildAttachedSession(profile, adapter, this.#now());
    this.#registerLiveSession(profile, adapter, session);
    this.#publish(buildSessionCreatedEvent(session, this.#nextSequence(), session.createdAt));
    return this.#requireSession(session.id);
  }

  async resumeSession(sessionId: HarnessSessionId): Promise<HarnessSession> {
    const liveSession = await this.#resolveLiveSession(sessionId);
    const session = await liveSession.adapter.resumeSession({ session: liveSession.session });
    liveSession.session = session;
    this.#startStreaming(asSessionKey(sessionId));
    return session;
  }

  async sendTurn(input: HarnessSendTurnInput & { readonly sessionId: HarnessSessionId }): Promise<void> {
    const liveSession = await this.#resolveLiveSession(input.sessionId);
    await liveSession.adapter.sendTurn({
      session: liveSession.session,
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    });
  }

  async cancelTurn(sessionId: HarnessSessionId): Promise<void> {
    const liveSession = await this.#resolveLiveSession(sessionId);
    await liveSession.adapter.cancelTurn({ session: liveSession.session });
  }

  async resolvePermission(
    input: HarnessResolvePermissionInput & { readonly sessionId: HarnessSessionId },
  ): Promise<void> {
    const liveSession = await this.#resolveLiveSession(input.sessionId);
    await liveSession.adapter.resolvePermission({
      session: liveSession.session,
      requestId: input.requestId,
      decision: input.decision,
    });
  }

  async resolveElicitation(
    input: HarnessResolveElicitationInput & { readonly sessionId: HarnessSessionId },
  ): Promise<void> {
    const liveSession = await this.#resolveLiveSession(input.sessionId);
    await liveSession.adapter.resolveElicitation({
      session: liveSession.session,
      requestId: input.requestId,
      answers: input.answers,
    });
  }

  async updateSessionConfig(
    input: HarnessUpdateSessionConfigInput & { readonly sessionId: HarnessSessionId },
  ): Promise<void> {
    const liveSession = await this.#resolveLiveSession(input.sessionId);
    await liveSession.adapter.updateSessionConfig({
      session: liveSession.session,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    });
  }

  async shutdownSession(sessionId: HarnessSessionId): Promise<void> {
    const liveSession = await this.#resolveLiveSession(sessionId);
    liveSession.streamAbort?.abort();
    await liveSession.adapter.shutdownSession({ session: liveSession.session });
    this.#liveSessions.delete(asSessionKey(sessionId));
  }

  publishConnectorEvent(event: HarnessEvent): HarnessEvent {
    return this.#publish(event);
  }

  #publish(event: HarnessEvent): HarnessEvent {
    const stored = this.#store.appendEvent(event);
    const snapshot = this.#store.getSnapshot();
    const key = asSessionKey(event.sessionId);
    const liveSession = this.#liveSessions.get(key);
    if (liveSession) {
      const updated = snapshot.sessions.find((session) => session.id === event.sessionId);
      if (updated) {
        liveSession.session = updated;
      }
    }
    for (const listener of this.#listeners) {
      listener(stored, snapshot);
    }
    return stored;
  }

  #resolveAdapter(harness: HarnessProfile["harness"]): HarnessAdapter {
    const adapter = this.#adapters.get(harness);
    if (!adapter) {
      throw new HarnessAdapterError(`No harness adapter registered for '${harness}'.`);
    }
    return adapter;
  }

  #registerLiveSession(profile: HarnessProfile, adapter: HarnessAdapter, session: HarnessSession): void {
    this.#liveSessions.set(asSessionKey(session.id), {
      adapter,
      profile,
      session,
    });
  }

  async #resolveLiveSession(sessionId: HarnessSessionId): Promise<LiveSessionState> {
    const key = asSessionKey(sessionId);
    const existing = this.#liveSessions.get(key);
    if (existing) {
      return existing;
    }
    const session = this.#requireSession(sessionId);
    if (!session.profileId) {
      throw new HarnessAdapterError(`Session '${sessionId}' is missing a bound profile.`);
    }
    const profile = findProfile(this.#store.getSnapshot(), session.profileId);
    const adapter = this.#resolveAdapter(session.harness);
    const liveSession = { adapter, profile, session };
    this.#liveSessions.set(key, liveSession);
    return liveSession;
  }

  #requireSession(sessionId: HarnessSessionId): HarnessSession {
    const session = this.#store.getSnapshot().sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      throw new HarnessAdapterError(`Unknown harness session '${sessionId}'.`);
    }
    return session;
  }

  #nextSequence(): number {
    return this.#store.getSnapshot().sequence + 1;
  }

  #startStreaming(sessionKey: string): void {
    const liveSession = this.#liveSessions.get(sessionKey);
    if (!liveSession || !liveSession.adapter.streamEvents) {
      return;
    }
    liveSession.streamAbort?.abort();
    const controller = new AbortController();
    liveSession.streamAbort = controller;
    void (async () => {
      try {
        for await (const event of liveSession.adapter.streamEvents!({
          session: liveSession.session,
          signal: controller.signal,
        })) {
          this.#publish(event);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        this.#publish({
          eventId: createEventId("harness-stream-error", liveSession.session.id, this.#nextSequence()),
          sessionId: liveSession.session.id,
          createdAt: this.#now(),
          sequence: this.#nextSequence(),
          harness: liveSession.session.harness,
          adapterKey: liveSession.session.adapterKey,
          connectionMode: liveSession.session.connectionMode,
          type: "transport.error",
          payload: {
            message: error instanceof Error ? error.message : "Harness stream failed",
          },
        });
      }
    })();
  }
}
