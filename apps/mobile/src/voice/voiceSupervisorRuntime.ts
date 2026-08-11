import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { VoiceSupervisorEnvironment } from "@t3tools/client-runtime/operations/voice-supervisor-repository";
import type {
  BuiltFollowUpThreadInput,
  BuiltInterruptThreadInput,
  BuiltStartProjectTaskInput,
} from "@t3tools/client-runtime/operations/thread-tasks";
import type { VoiceToolsController } from "@t3tools/client-runtime/operations/voice-supervisor-tools";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { mintVoiceClientSecret } from "@t3tools/client-runtime/state/voice";
import { RealtimeSessionError } from "@t3tools/client-runtime/voice/realtime-transport";
import type { VoiceSupervisorData } from "@t3tools/client-runtime/voice/voice-supervisor-state";
import {
  DEFAULT_REALTIME_VOICE,
  REALTIME_VOICES,
  type EnvironmentId,
  type ProjectReadFileResult,
  type RealtimeVoice,
  type ServerConfig,
  type VcsListRefsResult,
  type VoiceRealtimeClientSecret,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { runtime as mobileRuntime } from "../lib/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { projectEnvironment } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { environmentSession } from "../state/session";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import {
  createDefaultMobileVoiceToolsController,
  createMobileVoiceSupervisorHostController,
  voiceCredentialSessionError,
  type MobileVoiceSupervisorHostController,
  type VoiceSupervisorConfirmation,
} from "./voiceSupervisorHost";
import { createMobileVoiceSupervisorStore } from "./voiceSupervisorStore";
import { createVoiceMobileStartDefaultsResolver } from "./voiceStartDefaults";
import {
  createVoiceToolsMobileRepository,
  type VoiceMobileThreadNavigationParams,
} from "./voiceToolsRepository";

const EMPTY_CONFIRMATIONS: ReadonlyArray<VoiceSupervisorConfirmation> = Object.freeze([]);
const HOST_UNAVAILABLE_MESSAGE = "The selected voice host environment became unavailable.";

export interface MobileVoiceHostLease {
  readonly environmentId: EnvironmentId;
  readonly connectionGeneration: number;
  readonly prepared: PreparedConnection;
}

export interface MobileVoiceAuthority {
  readonly environmentIds: () => ReadonlyArray<EnvironmentId>;
  readonly readLease: (environmentId: EnvironmentId) => MobileVoiceHostLease | null;
  readonly subscribeLease: (environmentId: EnvironmentId, listener: () => void) => () => void;
  readonly readEnvironments: () => ReadonlyArray<VoiceSupervisorEnvironment>;
  readonly readServerConfig: (environmentId: EnvironmentId) => ServerConfig | null;
  readonly subscribeCatalog: (listener: () => void) => () => void;
}

export interface MobileVoiceSupervisorSelection {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedVoice: RealtimeVoice;
  readonly startError: string | null;
}

export interface MobileVoiceSupervisorCompactState {
  readonly generation: number;
  readonly phase: VoiceSupervisorData["phase"];
  readonly muted: boolean;
  readonly pendingConfirmationCount: number;
  readonly pendingConfirmationSummary: string | null;
}

export interface MobileVoiceSupervisorBinding {
  readonly voiceGeneration: number;
  readonly environmentId: EnvironmentId;
  readonly connectionGeneration: number;
  readonly voice: RealtimeVoice;
}

interface ActiveMobileVoiceSupervisorBinding {
  readonly value: MobileVoiceSupervisorBinding;
  readonly ownership: AbortController;
}

type VoiceCommandAcceptance = AtomCommandResult<{ readonly sequence: number }, unknown>;

interface ReadProjectFileRequest {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly cwd: string;
    readonly relativePath: string;
  };
}

interface ListRefsRequest {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly cwd: string;
    readonly limit: 100;
  };
}

export interface MobileVoiceSupervisorRuntimeDependencies {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly authority: MobileVoiceAuthority;
  readonly navigateThread: (params: VoiceMobileThreadNavigationParams) => unknown;
  readonly readProjectFile: (request: ReadProjectFileRequest) => Promise<ProjectReadFileResult>;
  readonly listRefs: (
    request: ListRefsRequest,
  ) => Promise<Pick<VcsListRefsResult, "isRepo" | "refs">>;
  readonly startThreadTurn: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: BuiltStartProjectTaskInput | BuiltFollowUpThreadInput;
  }) => Promise<VoiceCommandAcceptance>;
  readonly interruptThreadTurn: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: BuiltInterruptThreadInput;
  }) => Promise<VoiceCommandAcceptance>;
  readonly mintClientSecret: (input: {
    readonly prepared: PreparedConnection;
    readonly voice: RealtimeVoice;
    readonly signal: AbortSignal;
  }) => Promise<VoiceRealtimeClientSecret>;
  readonly createHost?: (
    state: ReturnType<typeof createMobileVoiceSupervisorStore>["projector"],
  ) => MobileVoiceSupervisorHostController;
  readonly createToolsController?: (input: {
    readonly environmentId: EnvironmentId;
    readonly authority: MobileVoiceAuthority;
    readonly resolveStartThreadDefaults: ReturnType<typeof createVoiceMobileStartDefaultsResolver>;
    readonly dependencies: MobileVoiceSupervisorRuntimeDependencies;
  }) => VoiceToolsController;
}

export interface MobileVoiceSupervisorRuntime {
  readonly dataAtom: Atom.Atom<VoiceSupervisorData>;
  readonly selectionAtom: Atom.Atom<MobileVoiceSupervisorSelection>;
  readonly confirmationsAtom: Atom.Atom<ReadonlyArray<VoiceSupervisorConfirmation>>;
  readonly compactAtom: Atom.Atom<MobileVoiceSupervisorCompactState>;
  readonly start: () => number | null;
  readonly stop: () => void;
  readonly setMuted: (muted: boolean) => void;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  readonly selectVoice: (voice: RealtimeVoice) => void;
  readonly confirm: (generation: number, callId: string) => void;
  readonly deny: (generation: number, callId: string) => void;
  readonly getActiveBinding: () => MobileVoiceSupervisorBinding | null;
  readonly dispose: () => void;
}

function readConnectionState(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): SupervisorConnectionState | null {
  return Option.getOrNull(
    AsyncResult.value(registry.get(environmentCatalog.stateAtom(environmentId))),
  );
}

export function readAuthoritativeMobileVoiceHostLease(input: {
  readonly environmentId: EnvironmentId;
  readonly catalogContainsEnvironment: boolean;
  readonly connection: SupervisorConnectionState | null;
  readonly config: {
    readonly environment: {
      readonly capabilities: { readonly realtimeVoice?: boolean };
    };
  } | null;
  readonly prepared: PreparedConnection | null;
}): MobileVoiceHostLease | null {
  if (
    !input.catalogContainsEnvironment ||
    input.connection === null ||
    connectionProjectionPhase(input.connection) !== "ready" ||
    input.config?.environment.capabilities.realtimeVoice !== true ||
    input.prepared?.environmentId !== input.environmentId
  ) {
    return null;
  }
  return Object.freeze({
    environmentId: input.environmentId,
    connectionGeneration: input.connection.generation,
    prepared: input.prepared,
  });
}

export function createMobileVoiceAuthority(
  registry: AtomRegistry.AtomRegistry,
): MobileVoiceAuthority {
  const readLease = (environmentId: EnvironmentId): MobileVoiceHostLease | null => {
    const catalogContainsEnvironment = registry
      .get(environmentCatalog.catalogValueAtom)
      .entries.has(environmentId);
    const connection = readConnectionState(registry, environmentId);
    const config = registry.get(serverEnvironment.configValueAtom(environmentId));
    const prepared = Option.getOrNull(
      registry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    return readAuthoritativeMobileVoiceHostLease({
      environmentId,
      catalogContainsEnvironment,
      connection,
      config,
      prepared,
    });
  };

  return {
    environmentIds: () => [...registry.get(environmentCatalog.catalogValueAtom).entries.keys()],
    readLease,
    subscribeLease: (environmentId, listener) => {
      const unsubscribers = [
        registry.subscribe(environmentCatalog.stateAtom(environmentId), listener),
        registry.subscribe(serverEnvironment.configValueAtom(environmentId), listener),
        registry.subscribe(environmentSession.preparedConnectionValueAtom(environmentId), listener),
      ];
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
    readEnvironments: () => {
      const environments: VoiceSupervisorEnvironment[] = [];
      for (const [environmentId, entry] of registry.get(environmentCatalog.catalogValueAtom)
        .entries) {
        environments.push({
          environmentId,
          label: entry.target.label,
          connectionState:
            readConnectionState(registry, environmentId) ?? AVAILABLE_CONNECTION_STATE,
          shellState: registry.get(environmentShell.stateValueAtom(environmentId)),
        });
      }
      return environments;
    },
    readServerConfig: (environmentId) =>
      registry.get(serverEnvironment.configValueAtom(environmentId)),
    subscribeCatalog: (listener) =>
      registry.subscribe(environmentCatalog.catalogValueAtom, listener),
  };
}

function updateWritable<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Writable<A>,
  update: (current: A) => A,
): void {
  const current = registry.get(atom);
  const next = update(current);
  if (next !== current) registry.set(atom, next);
}

function sameCompactState(
  left: MobileVoiceSupervisorCompactState,
  right: MobileVoiceSupervisorCompactState,
): boolean {
  return (
    left.generation === right.generation &&
    left.phase === right.phase &&
    left.muted === right.muted &&
    left.pendingConfirmationCount === right.pendingConfirmationCount &&
    left.pendingConfirmationSummary === right.pendingConfirmationSummary
  );
}

function defaultToolsController(input: {
  readonly authority: MobileVoiceAuthority;
  readonly resolveStartThreadDefaults: ReturnType<typeof createVoiceMobileStartDefaultsResolver>;
  readonly dependencies: MobileVoiceSupervisorRuntimeDependencies;
}): VoiceToolsController {
  const repository = createVoiceToolsMobileRepository({
    readEnvironments: input.authority.readEnvironments,
    resolveStartThreadDefaults: input.resolveStartThreadDefaults,
    navigate: (_screen, params) => input.dependencies.navigateThread(params),
    startThreadTurn: input.dependencies.startThreadTurn,
    interruptThreadTurn: input.dependencies.interruptThreadTurn,
  });
  return createDefaultMobileVoiceToolsController(repository);
}

export function createMobileVoiceSupervisorRuntime(
  dependencies: MobileVoiceSupervisorRuntimeDependencies,
): MobileVoiceSupervisorRuntime {
  const { registry, authority } = dependencies;
  const store = createMobileVoiceSupervisorStore(registry);
  const selectionAtom = Atom.make<MobileVoiceSupervisorSelection>({
    selectedEnvironmentId: null,
    selectedVoice: DEFAULT_REALTIME_VOICE,
    startError: null,
  }).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-supervisor:selection"));
  const confirmationsAtom = Atom.make<ReadonlyArray<VoiceSupervisorConfirmation>>(
    EMPTY_CONFIRMATIONS,
  ).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-supervisor:confirmations"));
  let compactSnapshot: MobileVoiceSupervisorCompactState = Object.freeze({
    generation: 0,
    phase: "idle",
    muted: false,
    pendingConfirmationCount: 0,
    pendingConfirmationSummary: null,
  });
  const compactAtom = Atom.make((get) => {
    const data = get(store.dataAtom);
    const confirmations = get(confirmationsAtom);
    const next: MobileVoiceSupervisorCompactState = {
      generation: data.generation,
      phase: data.phase,
      muted: data.muted,
      pendingConfirmationCount: confirmations.length,
      pendingConfirmationSummary: confirmations[0]?.summary ?? null,
    };
    if (sameCompactState(compactSnapshot, next)) return compactSnapshot;
    compactSnapshot = Object.freeze(next);
    return compactSnapshot;
  }).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-supervisor:compact"));
  const host =
    dependencies.createHost?.(store.projector) ??
    createMobileVoiceSupervisorHostController({ state: store.projector });

  let disposed = false;
  let activeBinding: ActiveMobileVoiceSupervisorBinding | null = null;
  let unsubscribeActiveLease: (() => void) | null = null;

  const setStartError = (message: string | null) =>
    updateWritable(registry, selectionAtom, (current) =>
      current.startError === message ? current : { ...current, startError: message },
    );

  const reconcileSelection = () => {
    if (disposed || activeBinding !== null) return;
    const ids = authority.environmentIds();
    updateWritable(registry, selectionAtom, (current) => {
      if (current.selectedEnvironmentId !== null && ids.includes(current.selectedEnvironmentId)) {
        return current;
      }
      return {
        ...current,
        selectedEnvironmentId: ids[0] ?? null,
        startError: null,
      };
    });
  };

  const clearActiveBinding = () => {
    activeBinding?.ownership.abort();
    unsubscribeActiveLease?.();
    unsubscribeActiveLease = null;
    activeBinding = null;
  };

  const invalidateIfLeaseChanged = (expected: ActiveMobileVoiceSupervisorBinding) => {
    if (disposed || activeBinding !== expected) return;
    const current = authority.readLease(expected.value.environmentId);
    if (current !== null && current.connectionGeneration === expected.value.connectionGeneration) {
      return;
    }
    clearActiveBinding();
    host.hostUnavailable(HOST_UNAVAILABLE_MESSAGE);
    reconcileSelection();
  };

  const handleCatalogChange = () => {
    const binding = activeBinding;
    if (binding === null) {
      reconcileSelection();
      return;
    }
    if (!authority.environmentIds().includes(binding.value.environmentId)) {
      clearActiveBinding();
      host.hostUnavailable(HOST_UNAVAILABLE_MESSAGE);
      reconcileSelection();
      return;
    }
    invalidateIfLeaseChanged(binding);
  };

  const unsubscribeHost = host.subscribe(() => {
    const confirmations = host.getSnapshot().confirmations;
    updateWritable(registry, confirmationsAtom, (current) =>
      current === confirmations ? current : confirmations,
    );
  });
  const unsubscribeState = registry.subscribe(store.dataAtom, (data) => {
    const binding = activeBinding;
    if (
      binding !== null &&
      data.generation === binding.value.voiceGeneration &&
      data.phase !== "connecting" &&
      data.phase !== "connected"
    ) {
      clearActiveBinding();
      reconcileSelection();
    }
  });
  const unsubscribeCatalog = authority.subscribeCatalog(handleCatalogChange);
  reconcileSelection();

  const createToolsController = (environmentId: EnvironmentId) => {
    const resolveStartThreadDefaults = createVoiceMobileStartDefaultsResolver({
      readTargetServerConfig: authority.readServerConfig,
      readProjectFile: dependencies.readProjectFile,
      listRefs: dependencies.listRefs,
    });
    return (
      dependencies.createToolsController?.({
        environmentId,
        authority,
        resolveStartThreadDefaults,
        dependencies,
      }) ?? defaultToolsController({ authority, resolveStartThreadDefaults, dependencies })
    );
  };

  const start = (): number | null => {
    if (disposed) return null;
    const data = registry.get(store.dataAtom);
    if (data.phase === "connecting" || data.phase === "connected") return null;
    const selection = registry.get(selectionAtom);
    const environmentId = selection.selectedEnvironmentId;
    if (environmentId === null) {
      setStartError("No execution environment is available.");
      return null;
    }
    const lease = authority.readLease(environmentId);
    if (lease === null) {
      setStartError(HOST_UNAVAILABLE_MESSAGE);
      return null;
    }
    const startAuthority = Object.freeze({
      environmentId,
      connectionGeneration: lease.connectionGeneration,
      voice: selection.selectedVoice,
    });
    const ownership = new AbortController();
    let voiceGeneration: number | null = null;
    const isOwned = () =>
      !disposed &&
      !ownership.signal.aborted &&
      (voiceGeneration === null ||
        (activeBinding?.value.voiceGeneration === voiceGeneration &&
          activeBinding.value.environmentId === startAuthority.environmentId &&
          activeBinding.value.connectionGeneration === startAuthority.connectionGeneration &&
          activeBinding.value.voice === startAuthority.voice));
    setStartError(null);
    voiceGeneration = host.start({
      voice: startAuthority.voice,
      getClientSecret: async (signal) => {
        if (signal.aborted || !isOwned()) {
          throw new RealtimeSessionError("client_secret_failed");
        }
        const current = authority.readLease(startAuthority.environmentId);
        if (
          current === null ||
          current.connectionGeneration !== startAuthority.connectionGeneration
        ) {
          throw new RealtimeSessionError("client_secret_failed");
        }
        try {
          const secret = await dependencies.mintClientSecret({
            prepared: current.prepared,
            voice: startAuthority.voice,
            signal,
          });
          if (signal.aborted || !isOwned()) {
            throw new RealtimeSessionError("client_secret_failed");
          }
          return secret;
        } catch (error) {
          throw voiceCredentialSessionError(error);
        }
      },
      createToolsController: () => createToolsController(startAuthority.environmentId),
    });
    const value = Object.freeze({
      voiceGeneration,
      environmentId: startAuthority.environmentId,
      connectionGeneration: startAuthority.connectionGeneration,
      voice: startAuthority.voice,
    });
    const binding = Object.freeze({
      value,
      ownership,
    });
    clearActiveBinding();
    activeBinding = binding;
    unsubscribeActiveLease = authority.subscribeLease(environmentId, () =>
      invalidateIfLeaseChanged(binding),
    );
    const currentData = registry.get(store.dataAtom);
    if (
      currentData.generation !== voiceGeneration ||
      (currentData.phase !== "connecting" && currentData.phase !== "connected")
    ) {
      clearActiveBinding();
      reconcileSelection();
      return voiceGeneration;
    }
    invalidateIfLeaseChanged(binding);
    return voiceGeneration;
  };

  return {
    dataAtom: store.dataAtom,
    selectionAtom,
    confirmationsAtom,
    compactAtom,
    start,
    stop: () => {
      if (disposed) return;
      clearActiveBinding();
      host.stop();
      if (registry.get(store.dataAtom).phase === "failed") store.projector.reset();
      reconcileSelection();
    },
    setMuted: host.setMuted,
    selectEnvironment: (environmentId) => {
      if (disposed) return;
      const data = registry.get(store.dataAtom);
      if (data.phase === "connecting" || data.phase === "connected") return;
      const selected = authority.environmentIds().find((candidate) => candidate === environmentId);
      if (selected === undefined) return;
      updateWritable(registry, selectionAtom, (current) =>
        current.selectedEnvironmentId === selected && current.startError === null
          ? current
          : { ...current, selectedEnvironmentId: selected, startError: null },
      );
    },
    selectVoice: (voice) => {
      if (disposed) return;
      const data = registry.get(store.dataAtom);
      if (data.phase === "connecting" || data.phase === "connected") return;
      const selected = REALTIME_VOICES.find((candidate) => candidate === voice);
      if (selected === undefined) return;
      updateWritable(registry, selectionAtom, (current) =>
        current.selectedVoice === selected && current.startError === null
          ? current
          : { ...current, selectedVoice: selected, startError: null },
      );
    },
    confirm: host.confirm,
    deny: host.deny,
    getActiveBinding: () => activeBinding?.value ?? null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearActiveBinding();
      unsubscribeCatalog();
      unsubscribeState();
      unsubscribeHost();
      host.dispose();
      registry.set(confirmationsAtom, EMPTY_CONFIRMATIONS);
      registry.set(selectionAtom, {
        selectedEnvironmentId: null,
        selectedVoice: DEFAULT_REALTIME_VOICE,
        startError: null,
      });
    },
  };
}

function unwrapQuery<A>(result: AtomCommandResult<A, unknown>): A {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

export function createDefaultMobileVoiceSupervisorRuntime(input: {
  readonly navigateThread: (params: VoiceMobileThreadNavigationParams) => unknown;
}): MobileVoiceSupervisorRuntime {
  const authority = createMobileVoiceAuthority(appAtomRegistry);
  return createMobileVoiceSupervisorRuntime({
    registry: appAtomRegistry,
    authority,
    navigateThread: input.navigateThread,
    readProjectFile: async (request) =>
      unwrapQuery(
        await executeAtomQuery(appAtomRegistry, projectEnvironment.readFile(request), {
          reportDefect: false,
          reportFailure: false,
        }),
      ),
    listRefs: async (request) =>
      unwrapQuery(
        await executeAtomQuery(appAtomRegistry, vcsEnvironment.listRefs(request), {
          reportDefect: false,
          reportFailure: false,
        }),
      ),
    startThreadTurn: (request) =>
      runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, request, {
        reportDefect: false,
        reportFailure: false,
      }),
    interruptThreadTurn: (request) =>
      runAtomCommand(appAtomRegistry, threadEnvironment.interruptTurn, request, {
        reportDefect: false,
        reportFailure: false,
      }),
    mintClientSecret: ({ prepared, voice, signal }) =>
      mobileRuntime.runPromise(
        Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
          return yield* mintVoiceClientSecret({ prepared, request: { voice }, signer });
        }),
        { signal },
      ),
  });
}
