import type {
  HarnessEvent,
  HarnessNativeFrame,
  HarnessProfile,
  HarnessSessionId,
  HarnessSnapshot,
} from "@t3tools/contracts";
import { createEmptyHarnessSnapshot, projectHarnessEvent } from "./projector";

export const HARNESS_SQLITE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS harness_profiles (
    id TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    adapter_family TEXT NOT NULL,
    connection_mode TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS harness_sessions (
    id TEXT PRIMARY KEY,
    profile_id TEXT,
    harness TEXT NOT NULL,
    adapter_key TEXT NOT NULL,
    connection_mode TEXT NOT NULL,
    title TEXT,
    cwd TEXT,
    model TEXT,
    mode TEXT,
    state TEXT NOT NULL,
    active_turn_id TEXT,
    native_session_id TEXT,
    last_error TEXT,
    capabilities_json TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS harness_bindings (
    session_id TEXT PRIMARY KEY,
    profile_id TEXT,
    harness TEXT NOT NULL,
    adapter_key TEXT NOT NULL,
    connection_mode TEXT NOT NULL,
    native_session_id TEXT,
    native_thread_id TEXT,
    native_turn_id TEXT,
    resume_cursor_json TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS harness_events (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    adapter_key TEXT NOT NULL,
    connection_mode TEXT NOT NULL,
    turn_id TEXT,
    item_id TEXT,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    native_refs_json TEXT,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS harness_pending_permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    args_json TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS harness_pending_elicitations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    questions_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS harness_connectors (
    id TEXT PRIMARY KEY,
    profile_id TEXT,
    harness TEXT NOT NULL,
    adapter_key TEXT NOT NULL,
    health TEXT NOT NULL,
    description TEXT,
    version TEXT,
    last_seen_at TEXT NOT NULL,
    metadata_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS harness_native_frames (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    adapter_key TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS harness_blobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projection_state (
    projector TEXT PRIMARY KEY,
    last_sequence INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`,
] as const;

export class HarnessMemoryStore {
  #events: HarnessEvent[] = [];
  #profiles = new Map<string, HarnessProfile>();
  #nativeFrames = new Map<string, HarnessNativeFrame[]>();
  #snapshot: HarnessSnapshot;

  constructor(nowIso = new Date().toISOString()) {
    this.#snapshot = createEmptyHarnessSnapshot(nowIso);
  }

  upsertProfile(profile: HarnessProfile): HarnessProfile {
    this.#profiles.set(profile.id, profile);
    this.#snapshot = {
      ...this.#snapshot,
      profiles: Array.from(this.#profiles.values()).toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      updatedAt: profile.updatedAt,
    };
    return profile;
  }

  deleteProfile(profileId: string): boolean {
    const deleted = this.#profiles.delete(profileId);
    if (!deleted) {
      return false;
    }
    this.#snapshot = {
      ...this.#snapshot,
      profiles: Array.from(this.#profiles.values()).toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    };
    return true;
  }

  appendEvent(event: HarnessEvent): HarnessEvent {
    this.#events.push(event);
    this.#snapshot = projectHarnessEvent(this.#snapshot, event);
    if (event.type === "native.frame") {
      const frame: HarnessNativeFrame = {
        id: event.eventId,
        sessionId: event.sessionId,
        harness: event.harness,
        adapterKey: event.adapterKey,
        createdAt: event.createdAt,
        source: event.payload.source,
        payload: event.payload.payload,
      };
      const existing = this.#nativeFrames.get(event.sessionId) ?? [];
      existing.push(frame);
      this.#nativeFrames.set(event.sessionId, existing);
    }
    return event;
  }

  listProfiles(): ReadonlyArray<HarnessProfile> {
    return this.#snapshot.profiles;
  }

  listEvents(sessionId?: HarnessSessionId, fromSequence = 0): ReadonlyArray<HarnessEvent> {
    return this.#events.filter(
      (event) =>
        event.sequence >= fromSequence && (sessionId === undefined || event.sessionId === sessionId),
    );
  }

  listNativeFrames(sessionId: HarnessSessionId): ReadonlyArray<HarnessNativeFrame> {
    return this.#nativeFrames.get(sessionId) ?? [];
  }

  getSnapshot(): HarnessSnapshot {
    return this.#snapshot;
  }
}
