/**
 * Final shared voice wiring (Oracle MVP T7) — the single entry point the
 * voice panel and future consumers use.
 *
 * This module composes the pieces the earlier tasks built, without changing
 * any of them:
 *  - T2/T5's tool executor over the web client's authenticated machinery
 *    (`createWebVoiceToolHost` + `createVoiceToolExecutor`). One executor
 *    instance per voice module so T5's same-session replay short-circuit
 *    applies across reconnects; the derived-identifier path still guarantees
 *    no duplicate after a full restart.
 *  - T6's research observation bridge, fed by the same host and executor.
 *    The bridge survives voice reconnects; the live client does not, so
 *    `steer` and `emitMark` are bound through an indirection that re-points
 *    at the current client each time the panel creates one, and recovery is
 *    re-armed when a fresh session goes live.
 *  - T4's panel/controller integration is untouched: the panel passes
 *    `createClient` (this module's rebinding wrapper) and the shared
 *    executor into the existing controller deps.
 *
 * Configuration and persistence use the client's existing web storage
 * pattern (a namespaced `t3code:` localStorage key with a guarded in-memory
 * fallback, as `promptStashStore.ts` does; localStorage is per-origin, so
 * web and desktop share one store and mobile is out of MVP scope):
 *  - Worker profiles (`VoiceWorkerProfilesConfig`, routine/deep) live under
 *    `t3code:voice-worker-profiles:v1`. Reads are tolerant: missing,
 *    malformed, or partially malformed JSON decodes to the valid subset, and
 *    an unconfigured profile still fails `model_unavailable` by design
 *    (never a silent fallback).
 *  - Research delivery records live under `t3code:voice-delivery-records:v1`
 *    so a pending mapping survives a full client restart. Crash-window
 *    semantics (recorded): the store write happens after the steering send
 *    succeeds and the delivery key is recorded, so a crash between send and
 *    save can redeliver a result once after restart (at-least-once, the
 *    window T6 recorded; the documented `session.commentary.appended` ack
 *    is the future exactly-once hardening). localStorage writes are
 *    synchronous, so the window is one await wide, not a polling window.
 */
import type {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceRequestId,
  VoiceTimingMark,
} from "@t3tools/contracts";
import { createMemoryStorage } from "../lib/storage";
import {
  createVoiceLiveClient,
  type VoiceLiveClient,
  type VoiceLiveClientOptions,
} from "./live-client";
import {
  createResearchBridge,
  type VoiceDeliveryRecord,
  type VoiceDeliveryStore,
  type VoiceResearchBridge,
  type VoiceResearchBridgeDependencies,
  type VoiceWorkerProfileModel,
  type VoiceWorkerProfilesConfig,
} from "./research";
import {
  createVoiceToolExecutor,
  createWebVoiceToolHost,
  type VoiceToolExecutor,
  type VoiceToolHost,
} from "./tools";

// ---------------------------------------------------------------------------
// Guarded storage access (the promptStashStore pattern)
// ---------------------------------------------------------------------------

/** The synchronous storage subset the voice stores use. localStorage matches
    exactly; `createMemoryStorage` is structurally the same. Values read from
    a hypothetical async storage are treated as absent (the default localStorage
    and in-memory backends are both synchronous). */
export interface VoiceKeyValueStorage {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => unknown;
}

function resolveVoiceStorage(storage: VoiceKeyValueStorage | undefined): VoiceKeyValueStorage {
  if (storage !== undefined) {
    return storage;
  }
  // Reading the `localStorage` global itself can throw when storage is
  // blocked by policy; guard the access, not just the calls on it.
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    // Fall through to the in-memory fallback.
  }
  return createMemoryStorage() as unknown as VoiceKeyValueStorage;
}

// ---------------------------------------------------------------------------
// Worker-profile configuration surface
// ---------------------------------------------------------------------------

export const VOICE_WORKER_PROFILES_STORAGE_KEY = "t3code:voice-worker-profiles:v1";

const decodeProfile = (value: unknown): VoiceWorkerProfileModel | undefined => {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).instanceId === "string" &&
    typeof (value as Record<string, unknown>).model === "string"
  ) {
    const record = value as { instanceId: string; model: string };
    return { instanceId: record.instanceId, model: record.model };
  }
  return undefined;
};

/** Tolerant decode: a malformed entry is dropped, not fatal, so one bad
    hand-edited value cannot take the whole configuration surface down. */
export function decodeVoiceWorkerProfilesConfig(value: unknown): VoiceWorkerProfilesConfig {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const routine = decodeProfile(record.routine);
  const deep = decodeProfile(record.deep);
  return {
    ...(routine !== undefined ? { routine } : {}),
    ...(deep !== undefined ? { deep } : {}),
  };
}

/** Reads the worker-profile configuration. Unconfigured profiles fail
    `model_unavailable` in the bridge — that is the design, never a silent
    fallback to another model. */
export function readVoiceWorkerProfilesConfig(
  storage?: VoiceKeyValueStorage,
): VoiceWorkerProfilesConfig {
  const store = resolveVoiceStorage(storage);
  let raw: string | null;
  try {
    raw = store.getItem(VOICE_WORKER_PROFILES_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) {
    return {};
  }
  try {
    return decodeVoiceWorkerProfilesConfig(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Persists the worker-profile configuration. Write failures (quota,
    blocked storage) propagate to the caller — a settings surface must know
    the save did not land rather than silently lose it. */
export function saveVoiceWorkerProfilesConfig(
  config: VoiceWorkerProfilesConfig,
  storage?: VoiceKeyValueStorage,
): void {
  const store = resolveVoiceStorage(storage);
  store.setItem(VOICE_WORKER_PROFILES_STORAGE_KEY, JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// Research delivery records (client-durable VoiceDeliveryStore)
// ---------------------------------------------------------------------------

export const VOICE_DELIVERY_RECORDS_STORAGE_KEY = "t3code:voice-delivery-records:v1";

const DELIVERY_RECORD_STATUSES = ["watching", "auth_invalid", "failed"] as const;

const decodeDeliveryRecord = (value: unknown): VoiceDeliveryRecord | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const requiredString = (key: string): string | undefined =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  const requestId = requiredString("requestId");
  const environmentId = requiredString("environmentId");
  const projectId = requiredString("projectId");
  const threadId = requiredString("threadId");
  const status = DELIVERY_RECORD_STATUSES.find((candidate) => candidate === record.status);
  if (
    requestId === undefined ||
    environmentId === undefined ||
    projectId === undefined ||
    threadId === undefined ||
    status === undefined ||
    typeof record.afterSequence !== "number"
  ) {
    return undefined;
  }
  return {
    requestId: requestId as VoiceRequestId,
    environmentId: environmentId as EnvironmentId,
    projectId: projectId as ProjectId,
    threadId: threadId as ThreadId,
    afterSequence: record.afterSequence,
    status,
    deliveredTurnIds: Array.isArray(record.deliveredTurnIds)
      ? record.deliveredTurnIds.filter((key): key is string => typeof key === "string")
      : [],
    ...(typeof record.lastError === "string" ? { lastError: record.lastError } : {}),
  };
};

/** Client-durable delivery store: the pending-delivery mapping survives a
    full client restart, so `recover()` on a fresh module resumes observation
    from the persisted `afterSequence` and the persisted exactly-once ledger.
    Crash-window semantics are documented on the module header. */
export function createWebVoiceDeliveryStore(storage?: VoiceKeyValueStorage): VoiceDeliveryStore {
  const store = resolveVoiceStorage(storage);

  const loadAll = (): VoiceDeliveryRecord[] => {
    let raw: string | null;
    try {
      raw = store.getItem(VOICE_DELIVERY_RECORDS_STORAGE_KEY);
    } catch {
      return [];
    }
    if (raw === null) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map(decodeDeliveryRecord)
        .filter((record): record is VoiceDeliveryRecord => record !== undefined);
    } catch {
      return [];
    }
  };

  const saveAll = (records: ReadonlyArray<VoiceDeliveryRecord>): void => {
    store.setItem(VOICE_DELIVERY_RECORDS_STORAGE_KEY, JSON.stringify(records));
  };

  return {
    async load() {
      return loadAll();
    },
    async save(record) {
      const records = loadAll().filter((candidate) => candidate.requestId !== record.requestId);
      records.push(record);
      saveAll(records);
    },
  };
}

// ---------------------------------------------------------------------------
// The voice module
// ---------------------------------------------------------------------------

export interface VoiceModuleOptions {
  /** Host/executor injection: production defaults to the web client's
      authenticated machinery (`createWebVoiceToolHost` +
      `createVoiceToolExecutor`); tests inject mocks. */
  readonly host?: VoiceToolHost;
  readonly executor?: VoiceToolExecutor;
  /** Live client factory; production defaults to `createVoiceLiveClient`.
      Injectable so wiring tests can drive fake sessions. */
  readonly createClient?: (options: VoiceLiveClientOptions) => VoiceLiveClient;
  /** Storage for the profile configuration and delivery records; defaults
      to guarded localStorage with an in-memory fallback. */
  readonly storage?: VoiceKeyValueStorage;
  /** Remaining options pass through to the research bridge (tests inject a
      manual scheduler; production keeps the default timers). */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}

export interface VoiceModule {
  readonly host: VoiceToolHost;
  /** The shared T2/T5 executor. One instance per module so the same-session
      replay short-circuit applies across voice reconnects. */
  readonly executor: VoiceToolExecutor;
  readonly research: VoiceResearchBridge;
  /** Worker-profile configuration surface (persisted, client-readable).
      Unconfigured profiles fail `model_unavailable` by design. */
  readonly profiles: {
    read(): VoiceWorkerProfilesConfig;
    save(config: VoiceWorkerProfilesConfig): void;
  };
  /** Live client factory the panel passes to the controller. Each created
      client becomes the steering/mark target (the bridge survives
      reconnects; the client does not), and research recovery is re-armed
      once the fresh session goes live. */
  readonly createClient: (options: VoiceLiveClientOptions) => VoiceLiveClient;
  /** The client steering is currently bound to (diagnostics and tests). */
  readonly boundClient: () => VoiceLiveClient | undefined;
  /** Releases the research observers and the client binding. Reversible by
      explicit use: React StrictMode's simulated unmount runs cleanup while
      keeping the panel's component state, so the next client creation (or
      research access) re-arms a fresh observation bridge from the durable
      store. A real unmount never uses the module again. Disposal never marks
      a pending delivery delivered — the at-least-once semantics are
      untouched. */
  dispose(): void;
}

export function createVoiceModule(options: VoiceModuleOptions = {}): VoiceModule {
  const host = options.host ?? createWebVoiceToolHost();
  const executor = options.executor ?? createVoiceToolExecutor(host);
  const clientFactory = options.createClient ?? createVoiceLiveClient;
  const deliveryStore = createWebVoiceDeliveryStore(options.storage);

  let currentClient: VoiceLiveClient | undefined;

  const bridgeDependencies = {
    host,
    executor,
    // Read lazily per delegation so a profile edit takes effect without
    // re-creating the module.
    profiles: () => readVoiceWorkerProfilesConfig(options.storage),
    // Indirection on purpose: the bridge outlives any one live client, so
    // the panel re-points these at each newly created client.
    steer: (content: string) => currentClient?.steer?.(content) ?? false,
    emitMark: (mark: VoiceTimingMark, detail?: string) => currentClient?.emitMark(mark, detail),
    store: deliveryStore,
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  } satisfies VoiceResearchBridgeDependencies;

  let research = createResearchBridge(bridgeDependencies);
  let researchDisposed = false;
  /** The current client's recovery-listener unsubscribe. Retained and swapped
      per client so a replaced or disposed client's late live events can never
      re-arm observation on behalf of a dead session. */
  let unsubscribeRecovery: (() => void) | undefined;

  /** Disposal is reversible by design: the next explicit use re-arms a fresh
      bridge over the same durable store, so recovery after a disposal cycle
      still delivers exactly once per persisted key. */
  const ensureResearch = (): VoiceResearchBridge => {
    if (researchDisposed) {
      research = createResearchBridge(bridgeDependencies);
      researchDisposed = false;
    }
    return research;
  };

  const createClient = (clientOptions: VoiceLiveClientOptions): VoiceLiveClient => {
    const client = clientFactory(clientOptions);
    currentClient = client;
    // Detach the previous client's listener before subscribing the new one.
    unsubscribeRecovery?.();
    unsubscribeRecovery = client.onEvent((event) => {
      // Reconnect recovery: the fresh session can steer again, so re-arm
      // observation for persisted records that are still watching. The
      // delivery ledger prevents any duplicate delivery. The identity fence
      // keeps a late event from a detached client from acting on behalf of a
      // newer session (belt to the unsubscribe braces above).
      if (event.type === "state" && event.state === "live" && currentClient === client) {
        void ensureResearch().recover();
      }
    });
    return client;
  };

  return {
    host,
    executor,
    get research() {
      return ensureResearch();
    },
    profiles: {
      read: () => readVoiceWorkerProfilesConfig(options.storage),
      save: (config) => saveVoiceWorkerProfilesConfig(config, options.storage),
    },
    createClient,
    boundClient: () => currentClient,
    dispose: () => {
      // Detach the current client's recovery listener: after disposal no
      // client event may revive the bridge or re-arm observation.
      unsubscribeRecovery?.();
      unsubscribeRecovery = undefined;
      research.dispose();
      researchDisposed = true;
      currentClient = undefined;
    },
  };
}
