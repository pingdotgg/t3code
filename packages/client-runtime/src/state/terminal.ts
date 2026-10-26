import {
  type EnvironmentId,
  type TerminalAttachInput,
  type TerminalCloseInput,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalSummary,
  type TerminalWriteInput,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  type AtomCommand,
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  runAtomCommand,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, subscribeDynamic, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
  nextTerminalAttachSeedState,
  type TerminalBufferState,
} from "./terminalSession.ts";
import { terminalOutputText } from "./terminalOutput.ts";

export function createTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const terminalThreadKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId]);
  const terminalSessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId, input.terminalId ?? null]);
  const lifecycleConcurrency = { mode: "serial" as const, key: terminalThreadKey };
  const atoms = {
    observe: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:observe",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalObserve>) =>
        Stream.suspend(() =>
          subscribe(WS_METHODS.terminalObserve, input).pipe(
            Stream.scan(nextTerminalAttachSeedState, applyTerminalAttachStreamEvent),
          ),
        ),
    }),
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>) => {
        // Retry an unanswered first attach unchanged so it can still open the shell.
        let replied = false;
        return subscribeDynamic(WS_METHODS.terminalAttach, () =>
          Effect.sync(() => (replied ? { ...input, resume: true } : input)),
        ).pipe(
          Stream.onFirst(() =>
            Effect.sync(() => {
              replied = true;
            }),
          ),
          Stream.scan(nextTerminalAttachSeedState, applyTerminalAttachStreamEvent),
        );
      },
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:events",
      tag: WS_METHODS.subscribeTerminalEvents,
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
          Stream.scan((): ReadonlyArray<TerminalSummary> => [], applyTerminalMetadataStreamEvent),
          // The scan seed is not an authoritative empty server snapshot.
          Stream.drop(1),
        ),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:open",
      tag: WS_METHODS.terminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: WS_METHODS.terminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: WS_METHODS.terminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: terminalSessionKey },
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:clear",
      tag: WS_METHODS.terminalClear,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:restart",
      tag: WS_METHODS.terminalRestart,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:close",
      tag: WS_METHODS.terminalClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
  return {
    ...atoms,
    createSession: (options: TerminalSessionOptions) => createTerminalSession(atoms, options),
  };
}

export interface TerminalLifecycleState {
  readonly wasRunning: boolean;
  /** The user has seen this terminal without operate permission. */
  readonly observed: boolean;
  readonly reopened: boolean;
}

export const INITIAL_TERMINAL_LIFECYCLE: TerminalLifecycleState = {
  wasRunning: false,
  observed: false,
  reopened: false,
};

export type TerminalLifecycleEvent =
  /** A viewer without operate permission is following this terminal. */
  | { readonly type: "observed" }
  | { readonly type: "detached"; readonly canOperate: boolean }
  | {
      readonly type: "status";
      readonly status: TerminalBufferState["status"];
      readonly version: number;
    }
  | { readonly type: "reopen-failed" };

export type TerminalLifecycleCommand = "exit" | "reopen" | null;

export function transitionTerminalLifecycle(
  state: TerminalLifecycleState,
  event: TerminalLifecycleEvent,
): { readonly state: TerminalLifecycleState; readonly command: TerminalLifecycleCommand } {
  switch (event.type) {
    case "observed":
      return { state: { ...state, observed: true }, command: null };
    case "detached":
      return {
        state: {
          ...state,
          // Losing operate while the shell runs leaves the viewer reading its history.
          observed: state.observed || (!event.canOperate && state.wasRunning),
          wasRunning: false,
        },
        command: null,
      };
    case "reopen-failed":
      return { state: { ...state, reopened: false }, command: null };
    case "status": {
      if (event.version === 0) return { state, command: null };
      if (event.status === "running" || event.status === "starting") {
        return { state: { ...state, wasRunning: true, reopened: false }, command: null };
      }
      if (event.status !== "closed" && event.status !== "exited") return { state, command: null };
      if (state.wasRunning) {
        return { state: { ...state, wasRunning: false, reopened: true }, command: "exit" };
      }
      // An explicit visit can reopen a cached ended session. Granting a viewer
      // operate permission must leave the history they were reading intact.
      if (state.observed || state.reopened) return { state, command: null };
      return { state: { ...state, reopened: true }, command: "reopen" };
    }
  }
}

export interface TerminalGridSize {
  readonly cols: number;
  readonly rows: number;
}

export type TerminalSessionMode =
  | { readonly kind: "observing" }
  | { readonly kind: "attached"; readonly input: TerminalAttachInput };

type EnvironmentCommand<Input> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: Input },
  unknown,
  unknown
>;

export interface TerminalSessionAtoms {
  readonly attach: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: TerminalAttachInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<TerminalBufferState, unknown>>;
  readonly observe: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId; readonly terminalId: string };
  }) => Atom.Atom<AsyncResult.AsyncResult<TerminalBufferState, unknown>>;
  readonly open: EnvironmentCommand<TerminalOpenInput>;
  readonly resize: EnvironmentCommand<TerminalResizeInput>;
  readonly write: EnvironmentCommand<TerminalWriteInput>;
  readonly close: EnvironmentCommand<TerminalCloseInput>;
}

export interface TerminalSessionOptions {
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly terminalId: string;
  };
  readonly gridSize: TerminalGridSize;
  /** Written once, as soon as the first attachment snapshot lands. */
  readonly initialInput?: string | undefined;
  /** Read right before every command, so revoking operate stops them at once. */
  readonly canOperate: () => boolean;
  /** The shell ended while attached; the store has already closed it. */
  readonly onExit: () => void;
  /** Fires when the shell starts or stops accepting input, and on every restart. */
  readonly onLiveChange?: (live: boolean) => void;
  readonly debugLog?: (message: string, data: Record<string, unknown>) => void;
}

export interface TerminalSession {
  /**
   * Mount while the session follows a terminal: attached to operate it, or
   * observing it read-only. `null` follows nothing. A session keeps the first
   * attach input it is given; a different input needs a new session.
   */
  readonly driver: (mode: TerminalSessionMode | null) => Atom.Atom<void>;
  /** The surface measured a new grid; the shell is resized while it runs. */
  readonly reportGridSize: (size: TerminalGridSize) => void;
}

/**
 * Owns one shown terminal's lifecycle: it reopens an ended shell on an explicit
 * visit, closes and reports a shell that exits while attached, replays the
 * measured grid whenever the server starts a new output generation, and writes
 * the launch's initial input once.
 */
export function createTerminalSession(
  atoms: TerminalSessionAtoms,
  options: TerminalSessionOptions,
): TerminalSession {
  const { environmentId, threadId, terminalId } = options.target;
  let lifecycle = INITIAL_TERMINAL_LIFECYCLE;
  let gridSize = options.gridSize;
  let generation: number | null = null;
  let liveLifecycleVersion: number | null = null;
  let initialInputPending = Boolean(options.initialInput);
  let lastStatus: TerminalBufferState["status"] | null = null;
  let loggedFirstOutput = false;
  let resizeRegistry: AtomRegistry.AtomRegistry | null = null;

  const sendResize = () => {
    if (generation === null || resizeRegistry === null || !options.canOperate()) return;
    void runAtomCommand(resizeRegistry, atoms.resize, {
      environmentId,
      input: { threadId, terminalId, cols: gridSize.cols, rows: gridSize.rows },
    });
  };

  const setLive = (next: number | null) => {
    if (next === liveLifecycleVersion) return;
    liveLifecycleVersion = next;
    options.onLiveChange?.(next !== null);
  };

  const apply = (
    event: TerminalLifecycleEvent,
    registry: AtomRegistry.AtomRegistry,
    input: TerminalAttachInput,
  ) => {
    const step = transitionTerminalLifecycle(lifecycle, event);
    lifecycle = step.state;
    if (step.command === "exit") {
      if (!options.canOperate()) return;
      void runAtomCommand(registry, atoms.close, {
        environmentId,
        input: { threadId, terminalId },
      });
      options.onExit();
      return;
    }
    if (step.command !== "reopen") return;
    const reopen = async () => {
      if (input.cwd === undefined || !options.canOperate()) return false;
      const result = await runAtomCommand(registry, atoms.open, {
        environmentId,
        input: {
          threadId,
          terminalId,
          cwd: input.cwd,
          worktreePath: input.worktreePath,
          cols: input.cols,
          rows: input.rows,
          ...(input.env ? { env: input.env } : {}),
        },
      });
      return result._tag === "Success";
    };
    void reopen().then((succeeded) => {
      if (!succeeded)
        lifecycle = transitionTerminalLifecycle(lifecycle, { type: "reopen-failed" }).state;
    });
  };

  const onAttachment = (
    registry: AtomRegistry.AtomRegistry,
    input: TerminalAttachInput,
    result: AsyncResult.AsyncResult<TerminalBufferState, unknown>,
  ) => {
    resizeRegistry = registry;
    const buffer = Option.getOrElse(AsyncResult.value(result), () => EMPTY_TERMINAL_BUFFER_STATE);
    const status = result._tag === "Failure" ? "error" : buffer.status;
    if (status !== lastStatus) {
      lastStatus = status;
      options.debugLog?.("session:status", {
        terminalId,
        status,
        error: buffer.error,
        version: buffer.version,
      });
    }
    if (!loggedFirstOutput && options.debugLog) {
      const text = terminalOutputText(buffer.output);
      if (text.length > 0) {
        loggedFirstOutput = true;
        options.debugLog("session:first-nonempty-buffer", {
          terminalId,
          length: text.length,
          preview: text.slice(0, 160),
        });
      }
    }

    setLive(status === "running" || status === "starting" ? buffer.lifecycleVersion : null);

    // Resize before the initial input so a launched command starts at the measured grid.
    const nextGeneration =
      buffer.version > 0 && status === "running" ? buffer.output.generation : null;
    if (nextGeneration !== generation) {
      generation = nextGeneration;
      sendResize();
    }

    if (initialInputPending && buffer.version > 0 && options.initialInput && options.canOperate()) {
      initialInputPending = false;
      void runAtomCommand(registry, atoms.write, {
        environmentId,
        input: { threadId, terminalId, data: options.initialInput },
      });
    }

    apply({ type: "status", status, version: buffer.version }, registry, input);
  };

  const label = `terminal-session:${environmentId}:${threadId}:${terminalId}`;
  const idle = Atom.make<void>(undefined);
  // Viewing read-only counts as observed before the first snapshot lands, so a
  // grant that arrives early still leaves the ended shell's history alone.
  const observing = Atom.make((get) => {
    // `subscribe`, not `get`: a rebuild would resubscribe on every output chunk.
    get.subscribe(
      atoms.observe({ environmentId, input: { threadId, terminalId } }),
      () => {
        if (options.canOperate()) return;
        lifecycle = transitionTerminalLifecycle(lifecycle, { type: "observed" }).state;
      },
      { immediate: true },
    );
  }).pipe(Atom.withLabel(`${label}:observing`));
  const makeAttached = (input: TerminalAttachInput) =>
    Atom.make((get) => {
      const registry = get.registry;
      get.addFinalizer(() => {
        generation = null;
        lastStatus = null;
        setLive(null);
        lifecycle = transitionTerminalLifecycle(lifecycle, {
          type: "detached",
          canOperate: options.canOperate(),
        }).state;
      });
      get.subscribe(
        atoms.attach({ environmentId, input }),
        (result) => onAttachment(registry, input, result),
        { immediate: true },
      );
    }).pipe(Atom.withLabel(`${label}:attached`));
  let attached: Atom.Atom<void> | null = null;

  return {
    driver: (mode) => {
      if (mode === null) return idle;
      if (mode.kind === "observing") return observing;
      attached ??= makeAttached(mode.input);
      return attached;
    },
    reportGridSize: (size) => {
      if (size.cols === gridSize.cols && size.rows === gridSize.rows) return;
      gridSize = size;
      sendResize();
    },
  };
}

export * from "./terminalSession.ts";
