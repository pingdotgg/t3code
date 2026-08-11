import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { SupervisorProposalHandle } from "@t3tools/client-runtime/operations/thread-supervisor";
import type {
  VoiceSupervisorToolName,
  VoiceToolResult,
  VoiceToolResultMap,
  VoiceToolsController,
} from "@t3tools/client-runtime/operations/voice-supervisor-tools";
import type {
  MobileVoiceSupervisorHostController,
  MobileVoiceSupervisorHostStartInput,
  VoiceSupervisorConfirmation,
} from "./voiceSupervisorHost";
import { decodeRealtimeServerEvent } from "@t3tools/client-runtime/voice/realtime-events";
import { EnvironmentId, type VoiceRealtimeClientSecret } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createMobileVoiceSupervisorRuntime,
  readAuthoritativeMobileVoiceHostLease,
  type MobileVoiceAuthority,
  type MobileVoiceHostLease,
  type MobileVoiceSupervisorRuntimeDependencies,
} from "./voiceSupervisorRuntime";

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000"),
  getRandomBytes: vi.fn((byteLength: number) => new Uint8Array(byteLength)),
}));

vi.mock("./realtimeSession", () => ({
  createMobileRealtimeSessionController: vi.fn(),
}));

vi.mock("../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../lib/runtime", () => ({ runtime: {} }));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../state/session", () => ({ environmentSession: {} }));
vi.mock("../state/shell", () => ({ environmentShell: {} }));
vi.mock("../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../state/vcs", () => ({ vcsEnvironment: {} }));

const ENVIRONMENT_ID = EnvironmentId.make("environment-mobile-voice");

function prepared(label: string): PreparedConnection {
  const target = new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label,
    httpBaseUrl: `https://${label}.example.test`,
    wsBaseUrl: `wss://${label}.example.test`,
  });
  return {
    environmentId: ENVIRONMENT_ID,
    label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: `${target.wsBaseUrl}/ws`,
    httpAuthorization: null,
    target,
  };
}

function lease(
  connectionGeneration: number,
  connection = prepared(`host-${connectionGeneration}`),
) {
  return Object.freeze({
    environmentId: ENVIRONMENT_ID,
    connectionGeneration,
    prepared: connection,
  }) satisfies MobileVoiceHostLease;
}

function tools(): VoiceToolsController {
  function invoke<Name extends VoiceSupervisorToolName>(
    _name: Name,
    _value: unknown,
  ): Promise<VoiceToolResultMap[Name]>;
  function invoke(_name: string, _value: unknown): Promise<VoiceToolResult>;
  function invoke() {
    return Promise.resolve({ status: "unknown-tool" as const });
  }
  return {
    definitions: [],
    invoke,
    getConfirmationPayloadLocally: () => ({ status: "proposal-not-found" }),
    cancelProposalLocally: () => ({ status: "cancelled" }),
    confirmProposalLocally: async (_handle: SupervisorProposalHandle) => ({
      status: "proposal-not-found",
    }),
  };
}

function authorityHarness(initialLease: MobileVoiceHostLease | null = lease(1)) {
  let currentLease = initialLease;
  let environmentIds: ReadonlyArray<EnvironmentId> = [ENVIRONMENT_ID];
  const leaseListeners: Array<{ active: boolean; listener: () => void }> = [];
  const catalogListeners: Array<{ active: boolean; listener: () => void }> = [];
  const authority: MobileVoiceAuthority = {
    environmentIds: () => environmentIds,
    readLease: () => currentLease,
    subscribeLease: (_environmentId, listener) => {
      const entry = { active: true, listener };
      leaseListeners.push(entry);
      return () => {
        entry.active = false;
      };
    },
    readEnvironments: () => [],
    readServerConfig: () => null,
    subscribeCatalog: (listener) => {
      const entry = { active: true, listener };
      catalogListeners.push(entry);
      return () => {
        entry.active = false;
      };
    },
  };
  return {
    authority,
    leaseListeners,
    setLease: (next: MobileVoiceHostLease | null, notify = true) => {
      currentLease = next;
      if (notify) {
        for (const entry of leaseListeners) if (entry.active) entry.listener();
      }
    },
    setEnvironmentIds: (next: ReadonlyArray<EnvironmentId>) => {
      environmentIds = next;
      for (const entry of catalogListeners) if (entry.active) entry.listener();
    },
  };
}

function hostHarness() {
  const inputs: MobileVoiceSupervisorHostStartInput[] = [];
  const listeners = new Set<() => void>();
  let confirmations: ReadonlyArray<VoiceSupervisorConfirmation> = Object.freeze([]);
  let nextGeneration = 0;
  let activeGeneration: number | null = null;
  let state: Parameters<NonNullable<MobileVoiceSupervisorRuntimeDependencies["createHost"]>>[0];

  const controller: MobileVoiceSupervisorHostController = {
    getSnapshot: () => ({ confirmations }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: vi.fn((input) => {
      inputs.push(input);
      input.createToolsController();
      activeGeneration = ++nextGeneration;
      state.beginSession(activeGeneration, activeGeneration);
      return activeGeneration;
    }),
    stop: vi.fn(() => {
      if (activeGeneration === null) return;
      const generation = activeGeneration;
      activeGeneration = null;
      confirmations = Object.freeze([]);
      for (const listener of listeners) listener();
      state.endSession(generation, generation);
    }),
    setMuted: vi.fn((muted) => {
      if (activeGeneration !== null) state.setMuted(activeGeneration, muted);
    }),
    confirm: vi.fn(),
    deny: vi.fn(),
    hostUnavailable: vi.fn((message) => {
      if (activeGeneration === null) return;
      const generation = activeGeneration;
      activeGeneration = null;
      confirmations = Object.freeze([]);
      for (const listener of listeners) listener();
      state.failSession(generation, message, generation);
    }),
    dispose: vi.fn(() => {
      activeGeneration = null;
      state.reset();
    }),
  };

  return {
    controller,
    inputs,
    createHost: (projector: typeof state) => {
      state = projector;
      return controller;
    },
    ingest: (event: NonNullable<ReturnType<typeof decodeRealtimeServerEvent>>) => {
      if (activeGeneration !== null) state.ingestEvent(activeGeneration, event, 10);
    },
  };
}

function runtimeHarness(initialLease: MobileVoiceHostLease | null = lease(1)) {
  const registry = AtomRegistry.make();
  const authority = authorityHarness(initialLease);
  const host = hostHarness();
  const createToolsController = vi.fn(() => tools());
  const mintClientSecret = vi.fn<MobileVoiceSupervisorRuntimeDependencies["mintClientSecret"]>(
    async () => ({
      clientSecret: "ek_mobile",
      expiresAt: 2_000_000_000,
      sessionId: "session-mobile",
    }),
  );
  const runtime = createMobileVoiceSupervisorRuntime({
    registry,
    authority: authority.authority,
    navigateThread: vi.fn(),
    readProjectFile: vi.fn(async () => ({
      relativePath: "t3.json",
      contents: "",
      byteLength: 0,
      truncated: false,
    })),
    listRefs: vi.fn(async () => ({ isRepo: false, refs: [] })),
    startThreadTurn: vi.fn(async () => AsyncResult.success({ sequence: 1 })),
    interruptThreadTurn: vi.fn(async () => AsyncResult.success({ sequence: 2 })),
    mintClientSecret,
    createHost: host.createHost,
    createToolsController,
  });
  return { registry, authority, host, runtime, createToolsController, mintClientSecret };
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("mobile Voice Supervisor runtime", () => {
  it("requires a ready, capable, exact-environment authoritative lease", () => {
    const connection = {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online" as const,
      phase: "connected" as const,
      attempt: 1,
      generation: 7,
    };
    const currentPrepared = prepared("authoritative");
    const capableConfig = { environment: { capabilities: { realtimeVoice: true } } };
    expect(
      readAuthoritativeMobileVoiceHostLease({
        environmentId: ENVIRONMENT_ID,
        catalogContainsEnvironment: true,
        connection,
        config: capableConfig,
        prepared: currentPrepared,
      }),
    ).toEqual({
      environmentId: ENVIRONMENT_ID,
      connectionGeneration: 7,
      prepared: currentPrepared,
    });
    expect(
      readAuthoritativeMobileVoiceHostLease({
        environmentId: ENVIRONMENT_ID,
        catalogContainsEnvironment: true,
        connection: { ...connection, phase: "backoff" },
        config: capableConfig,
        prepared: currentPrepared,
      }),
    ).toBeNull();
    expect(
      readAuthoritativeMobileVoiceHostLease({
        environmentId: ENVIRONMENT_ID,
        catalogContainsEnvironment: true,
        connection,
        config: { environment: { capabilities: {} } },
        prepared: currentPrepared,
      }),
    ).toBeNull();
    expect(
      readAuthoritativeMobileVoiceHostLease({
        environmentId: ENVIRONMENT_ID,
        catalogContainsEnvironment: true,
        connection,
        config: capableConfig,
        prepared: {
          ...currentPrepared,
          environmentId: EnvironmentId.make("environment-wrong"),
        },
      }),
    ).toBeNull();
    expect(
      readAuthoritativeMobileVoiceHostLease({
        environmentId: ENVIRONMENT_ID,
        catalogContainsEnvironment: false,
        connection,
        config: capableConfig,
        prepared: currentPrepared,
      }),
    ).toBeNull();
  });

  it("does not prepare tools, media, or credentials until explicit start", () => {
    const harness = runtimeHarness();

    expect(harness.createToolsController).not.toHaveBeenCalled();
    expect(harness.mintClientSecret).not.toHaveBeenCalled();
    expect(harness.host.controller.start).not.toHaveBeenCalled();

    expect(harness.runtime.start()).toBe(1);
    expect(harness.createToolsController).toHaveBeenCalledOnce();
    expect(harness.registry.get(harness.runtime.dataAtom).phase).toBe("connecting");
  });

  it("uses refreshed credentials in the same host lease and rejects generation rotation", async () => {
    const harness = runtimeHarness();
    harness.runtime.start();
    const getClientSecret = harness.host.inputs[0]?.getClientSecret;
    if (getClientSecret === undefined) throw new Error("Missing secret callback.");

    const refreshed = prepared("refreshed");
    harness.authority.setLease(lease(1, refreshed), false);
    await expect(getClientSecret(new AbortController().signal)).resolves.toMatchObject({
      sessionId: "session-mobile",
    });
    expect(harness.mintClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({ prepared: refreshed, voice: "marin" }),
    );

    harness.authority.setLease(lease(2), false);
    await expect(getClientSecret(new AbortController().signal)).rejects.toMatchObject({
      reason: "client_secret_failed",
      message: "T3 Code could not start a voice session.",
    });
    expect(harness.mintClientSecret).toHaveBeenCalledOnce();
  });

  it("invalidates host loss once and ignores stale observers after a later explicit start", () => {
    const harness = runtimeHarness();
    harness.runtime.start();
    const staleListener = harness.authority.leaseListeners[0]?.listener;
    if (staleListener === undefined) throw new Error("Missing lease listener.");

    harness.authority.setLease(null);
    expect(harness.host.controller.hostUnavailable).toHaveBeenCalledOnce();
    expect(harness.registry.get(harness.runtime.dataAtom).phase).toBe("failed");
    expect(harness.runtime.getActiveBinding()).toBeNull();

    harness.runtime.stop();
    harness.authority.setLease(lease(2), false);
    expect(harness.runtime.start()).toBe(2);
    expect(harness.runtime.getActiveBinding()).toMatchObject({
      voiceGeneration: 2,
      connectionGeneration: 2,
      voice: "marin",
    });

    staleListener();
    expect(harness.host.controller.hostUnavailable).toHaveBeenCalledOnce();
    expect(harness.registry.get(harness.runtime.dataAtom).phase).toBe("connecting");

    harness.authority.setLease(lease(3));
    expect(harness.host.controller.hostUnavailable).toHaveBeenCalledTimes(2);
    expect(harness.registry.get(harness.runtime.dataAtom).phase).toBe("failed");
  });

  it("fails an active session when its environment leaves the live catalog", () => {
    const harness = runtimeHarness();
    harness.runtime.start();

    harness.authority.setEnvironmentIds([]);

    expect(harness.host.controller.hostUnavailable).toHaveBeenCalledOnce();
    expect(harness.runtime.getActiveBinding()).toBeNull();
    expect(harness.registry.get(harness.runtime.dataAtom).phase).toBe("failed");
  });

  it("locks environment and voice selection while active and builds fresh tools per generation", () => {
    const otherEnvironment = EnvironmentId.make("environment-mobile-other");
    const harness = runtimeHarness();
    harness.authority.setEnvironmentIds([ENVIRONMENT_ID, otherEnvironment]);
    harness.runtime.start();
    harness.runtime.selectEnvironment(otherEnvironment);
    harness.runtime.selectVoice("cedar");
    expect(harness.registry.get(harness.runtime.selectionAtom)).toMatchObject({
      selectedEnvironmentId: ENVIRONMENT_ID,
      selectedVoice: "marin",
    });

    harness.runtime.stop();
    harness.runtime.selectEnvironment(otherEnvironment);
    harness.runtime.selectVoice("cedar");
    expect(harness.registry.get(harness.runtime.selectionAtom)).toMatchObject({
      selectedEnvironmentId: otherEnvironment,
      selectedVoice: "cedar",
    });
    harness.runtime.selectEnvironment(ENVIRONMENT_ID);
    harness.authority.setLease(lease(1), false);
    harness.runtime.start();
    expect(harness.createToolsController).toHaveBeenCalledTimes(2);
  });

  it("forwards local confirmation decisions with the exact generation and call ID", () => {
    const harness = runtimeHarness();

    harness.runtime.confirm(7, "call-confirm");
    harness.runtime.deny(8, "call-deny");

    expect(harness.host.controller.confirm).toHaveBeenCalledWith(7, "call-confirm");
    expect(harness.host.controller.deny).toHaveBeenCalledWith(8, "call-deny");
  });

  it("rejects a late minted secret after stop without reviving the old generation", async () => {
    const harness = runtimeHarness();
    const pending = deferred<VoiceRealtimeClientSecret>();
    harness.mintClientSecret.mockImplementationOnce(() => pending.promise);
    harness.runtime.start();
    const getClientSecret = harness.host.inputs[0]?.getClientSecret;
    if (getClientSecret === undefined) throw new Error("Missing secret callback.");
    const result = getClientSecret(new AbortController().signal);

    harness.runtime.stop();
    pending.resolve({
      clientSecret: "ek_late",
      expiresAt: 2_000_000_000,
      sessionId: "session-late",
    });

    await expect(result).rejects.toMatchObject({
      reason: "client_secret_failed",
      message: "T3 Code could not start a voice session.",
    });
    expect(harness.registry.get(harness.runtime.dataAtom).phase).toBe("idle");
  });

  it("rejects a stale secret callback without minting into a successor session", async () => {
    const harness = runtimeHarness();
    harness.runtime.start();
    const staleGetClientSecret = harness.host.inputs[0]?.getClientSecret;
    if (staleGetClientSecret === undefined) throw new Error("Missing secret callback.");

    harness.runtime.stop();
    harness.runtime.start();

    await expect(staleGetClientSecret(new AbortController().signal)).rejects.toMatchObject({
      reason: "client_secret_failed",
      message: "T3 Code could not start a voice session.",
    });
    expect(harness.mintClientSecret).not.toHaveBeenCalled();
    expect(harness.runtime.getActiveBinding()).toMatchObject({ voiceGeneration: 2 });
    expect(harness.registry.get(harness.runtime.dataAtom).phase).toBe("connecting");
  });

  it("does not notify compact subscribers for transcript-only projection updates", () => {
    const harness = runtimeHarness();
    harness.runtime.start();
    const initialCompact = harness.registry.get(harness.runtime.compactAtom);
    const listener = vi.fn();
    const unsubscribe = harness.registry.subscribe(harness.runtime.compactAtom, listener);
    listener.mockClear();
    const event = decodeRealtimeServerEvent({
      event_id: "transcript-complete",
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "transcript-item",
      transcript: "This must not rerender the root launcher.",
    });
    if (event === null) throw new Error("Invalid transcript fixture.");
    harness.host.ingest(event);

    expect(harness.registry.get(harness.runtime.compactAtom)).toBe(initialCompact);
    expect(listener).not.toHaveBeenCalled();
    expect(harness.registry.get(harness.runtime.dataAtom).transcript).toHaveLength(1);
    unsubscribe();
  });

  it("disposes once and resets all root-owned state", () => {
    const harness = runtimeHarness();
    harness.runtime.start();
    harness.runtime.setMuted(true);
    expect(harness.registry.get(harness.runtime.dataAtom).muted).toBe(true);

    harness.runtime.dispose();
    harness.runtime.dispose();
    expect(harness.host.controller.dispose).toHaveBeenCalledOnce();
    expect(harness.registry.get(harness.runtime.dataAtom)).toMatchObject({
      generation: 0,
      phase: "idle",
      transcript: [],
      activity: [],
    });
    expect(harness.runtime.start()).toBeNull();
  });
});
