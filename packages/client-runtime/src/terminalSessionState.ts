import type {
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { ThreadId, type TerminalAttachInput } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalSessionTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly terminalId: string | null;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export interface KnownTerminalMetadata {
  readonly target: KnownTerminalSessionTarget;
  readonly summary: TerminalSummary;
}

export interface TerminalSessionListFilter {
  readonly environmentId: EnvironmentId | null;
  readonly threadId?: ThreadId | null;
  readonly terminalId?: string | null;
}

export interface KnownTerminalSessionListFilter {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly terminalId: string | null;
}

export interface TerminalSessionManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly maxBufferBytes?: number;
}

export interface TerminalMetadataClient {
  readonly terminal: {
    readonly onMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => void,
      options?: { readonly onResubscribe?: () => void },
    ) => () => void;
  };
}

export interface TerminalAttachClient {
  readonly terminal: {
    readonly attach: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => void,
      options?: { readonly onResubscribe?: () => void },
    ) => () => void;
  };
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
});

const EMPTY_KNOWN_TERMINAL_SESSIONS = Object.freeze<Array<KnownTerminalSession>>([]);
const EMPTY_TERMINAL_ID_LIST = Object.freeze<Array<string>>([]);
const DEFAULT_MAX_BUFFER_BYTES = 512 * 1024;
const knownTerminalMetadataEnvironmentIds = new Set<EnvironmentId>();
const knownTerminalBufferTargets = new Map<string, KnownTerminalSessionTarget>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const terminalIdOrder = Order.make<string>(
  (left, right) => left.localeCompare(right, undefined, { numeric: true }) as -1 | 0 | 1,
);
const knownTerminalSessionOrder = Order.mapInput(
  terminalIdOrder,
  (session: KnownTerminalSession) => session.target.terminalId,
);
const knownTerminalSessionAcrossEnvironmentsOrder = Order.make<KnownTerminalSession>(
  (left, right) =>
    (left.target.environmentId.localeCompare(right.target.environmentId) ||
      left.target.threadId.localeCompare(right.target.threadId) ||
      terminalIdOrder(left.target.terminalId, right.target.terminalId)) as -1 | 0 | 1,
);

export const terminalSessionMetadataAtom = Atom.family((environmentId: EnvironmentId) => {
  knownTerminalMetadataEnvironmentIds.add(environmentId);
  return Atom.make<Record<string, KnownTerminalMetadata>>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel(`terminal-session:metadata:${environmentId}`),
  );
});

export const terminalSessionBufferAtom = Atom.family((target: KnownTerminalSessionTarget) => {
  const key = keyFromKnownTarget(target);
  knownTerminalBufferTargets.set(key, target);
  return Atom.make(EMPTY_TERMINAL_BUFFER_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`terminal-session:buffer:${key}`),
  );
});

export const EMPTY_TERMINAL_BUFFER_ATOM = Atom.make(EMPTY_TERMINAL_BUFFER_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("terminal-session:buffer:null"),
);

export const EMPTY_TERMINAL_SESSION_ATOM = Atom.make(EMPTY_TERMINAL_SESSION_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("terminal-session:state:null"),
);

export const EMPTY_KNOWN_TERMINAL_SESSIONS_ATOM = Atom.make(EMPTY_KNOWN_TERMINAL_SESSIONS).pipe(
  Atom.keepAlive,
  Atom.withLabel("terminal-session:known:null"),
);

export const EMPTY_TERMINAL_ID_LIST_ATOM = Atom.make(EMPTY_TERMINAL_ID_LIST).pipe(
  Atom.keepAlive,
  Atom.withLabel("terminal-session:running-terminal-ids:null"),
);

export function getKnownTerminalSessionTarget(
  target: TerminalSessionTarget,
): KnownTerminalSessionTarget | null {
  if (target.environmentId === null || target.threadId === null || target.terminalId === null) {
    return null;
  }

  return {
    environmentId: target.environmentId,
    threadId: target.threadId,
    terminalId: target.terminalId,
  };
}

export function getKnownTerminalSessionListFilter(
  filter: TerminalSessionListFilter,
): KnownTerminalSessionListFilter | null {
  if (filter.environmentId === null) {
    return null;
  }

  return {
    environmentId: filter.environmentId,
    threadId: filter.threadId ?? null,
    terminalId: filter.terminalId ?? null,
  };
}

function knownTargetFromSummary(
  environmentId: EnvironmentId,
  summary: TerminalSummary,
): KnownTerminalSessionTarget {
  return {
    environmentId,
    threadId: ThreadId.make(summary.threadId),
    terminalId: summary.terminalId,
  };
}

function keyFromKnownTarget(target: KnownTerminalSessionTarget): string {
  return `${target.environmentId}:${target.threadId}:${target.terminalId}`;
}

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

function bufferFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState {
  return {
    buffer: trimBufferToBytes(snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function combineSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    status: summary?.status ?? buffer.status,
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
  };
}

function listKnownSessionsFromMetadata(
  metadata: Record<string, KnownTerminalMetadata>,
  getBuffer: (target: KnownTerminalSessionTarget) => TerminalBufferState,
  filter?: Partial<KnownTerminalSessionTarget>,
): ReadonlyArray<KnownTerminalSession> {
  return pipe(
    Object.values(metadata),
    Arr.filterMap(({ target, summary }) => {
      if (filter?.environmentId && target.environmentId !== filter.environmentId) {
        return Result.failVoid;
      }
      if (filter?.threadId && target.threadId !== filter.threadId) {
        return Result.failVoid;
      }
      if (filter?.terminalId && target.terminalId !== filter.terminalId) {
        return Result.failVoid;
      }
      return Result.succeed({
        target,
        state: combineSessionState(summary, getBuffer(target)),
      });
    }),
    Arr.sort(knownTerminalSessionOrder),
  );
}

export const terminalSessionStateAtom = Atom.family((target: KnownTerminalSessionTarget) =>
  Atom.make((get) => {
    const targetKey = keyFromKnownTarget(target);
    return combineSessionState(
      get(terminalSessionMetadataAtom(target.environmentId))[targetKey]?.summary ?? null,
      get(terminalSessionBufferAtom(target)),
    );
  }).pipe(Atom.keepAlive, Atom.withLabel(`terminal-session:state:${keyFromKnownTarget(target)}`)),
);

export const knownTerminalSessionsAtom = Atom.family((filter: KnownTerminalSessionListFilter) =>
  Atom.make((get) =>
    listKnownSessionsFromMetadata(
      get(terminalSessionMetadataAtom(filter.environmentId)),
      (target) => get(terminalSessionBufferAtom(target)),
      {
        environmentId: filter.environmentId,
        ...(filter.threadId !== null ? { threadId: filter.threadId } : {}),
        ...(filter.terminalId !== null ? { terminalId: filter.terminalId } : {}),
      },
    ),
  ).pipe(Atom.keepAlive, Atom.withLabel(`terminal-session:known:${JSON.stringify(filter)}`)),
);

export const knownTerminalSessionsAcrossEnvironmentsAtom = Atom.family(
  (environmentIdsKey: string) =>
    Atom.make((get) => {
      const environmentIds = JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>;
      return pipe(
        environmentIds,
        Arr.flatMap((environmentId) =>
          listKnownSessionsFromMetadata(get(terminalSessionMetadataAtom(environmentId)), (target) =>
            get(terminalSessionBufferAtom(target)),
          ),
        ),
        Arr.sort(knownTerminalSessionAcrossEnvironmentsOrder),
      );
    }).pipe(
      Atom.keepAlive,
      Atom.withLabel(`terminal-session:known-across-environments:${environmentIdsKey}`),
    ),
);

export const runningTerminalIdsAtom = Atom.family((filter: KnownTerminalSessionListFilter) =>
  Atom.make((get) => {
    return pipe(
      Object.values(get(terminalSessionMetadataAtom(filter.environmentId))),
      Arr.filterMap((entry) =>
        entry.target.environmentId === filter.environmentId &&
        (filter.threadId === null || entry.target.threadId === filter.threadId) &&
        (filter.terminalId === null || entry.target.terminalId === filter.terminalId) &&
        entry.summary.hasRunningSubprocess
          ? Result.succeed(entry.target.terminalId)
          : Result.failVoid,
      ),
      Arr.sort(Order.String),
    );
  }).pipe(
    Atom.keepAlive,
    Atom.withLabel(`terminal-session:running-terminal-ids:${JSON.stringify(filter)}`),
  ),
);

export function createTerminalSessionManager(config: TerminalSessionManagerConfig) {
  const maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  function getMetadata(environmentId: EnvironmentId): Record<string, KnownTerminalMetadata> {
    return config.getRegistry().get(terminalSessionMetadataAtom(environmentId));
  }

  function setMetadata(
    environmentId: EnvironmentId,
    next: Record<string, KnownTerminalMetadata>,
  ): void {
    config.getRegistry().set(terminalSessionMetadataAtom(environmentId), next);
  }

  function getBuffer(target: KnownTerminalSessionTarget): TerminalBufferState {
    return config.getRegistry().get(terminalSessionBufferAtom(target));
  }

  function setBuffer(target: KnownTerminalSessionTarget, next: TerminalBufferState): void {
    config.getRegistry().set(terminalSessionBufferAtom(target), next);
  }

  function getSnapshot(target: TerminalSessionTarget): TerminalSessionState {
    const knownTarget = getKnownTerminalSessionTarget(target);
    if (knownTarget === null) {
      return EMPTY_TERMINAL_SESSION_STATE;
    }

    return combineSessionState(
      getMetadata(knownTarget.environmentId)[keyFromKnownTarget(knownTarget)]?.summary ?? null,
      getBuffer(knownTarget),
    );
  }

  function syncSnapshot(
    target: Pick<TerminalSessionTarget, "environmentId">,
    snapshot: TerminalSessionSnapshot,
  ): void {
    const knownTarget = getKnownTerminalSessionTarget({
      environmentId: target.environmentId,
      threadId: ThreadId.make(snapshot.threadId),
      terminalId: snapshot.terminalId,
    });
    if (knownTarget === null) {
      return;
    }

    setBuffer(knownTarget, bufferFromSnapshot(snapshot, maxBufferBytes));
  }

  function applyMetadataEvent(
    target: Pick<TerminalSessionTarget, "environmentId">,
    event: TerminalMetadataStreamEvent,
  ): void {
    const environmentId = target.environmentId;
    if (environmentId === null) {
      return;
    }

    if (event.type === "snapshot") {
      const retainedKeys = new Set<string>();
      const next = { ...getMetadata(environmentId) };

      for (const terminal of event.terminals) {
        const knownTarget = knownTargetFromSummary(environmentId, terminal);
        const targetKey = keyFromKnownTarget(knownTarget);
        retainedKeys.add(targetKey);
        next[targetKey] = {
          target: knownTarget,
          summary: terminal,
        };
      }

      for (const key of Object.keys(next)) {
        if (!retainedKeys.has(key)) {
          delete next[key];
        }
      }

      setMetadata(environmentId, next);
      return;
    }

    if (event.type === "upsert") {
      const knownTarget = knownTargetFromSummary(environmentId, event.terminal);
      const targetKey = keyFromKnownTarget(knownTarget);
      setMetadata(environmentId, {
        ...getMetadata(environmentId),
        [targetKey]: {
          target: knownTarget,
          summary: event.terminal,
        },
      });
      return;
    }

    const knownTarget = getKnownTerminalSessionTarget({
      environmentId,
      threadId: ThreadId.make(event.threadId),
      terminalId: event.terminalId,
    });
    if (knownTarget === null) {
      return;
    }

    const next = { ...getMetadata(environmentId) };
    delete next[keyFromKnownTarget(knownTarget)];
    setMetadata(environmentId, next);
  }

  function applyAttachEvent(
    target: Pick<TerminalSessionTarget, "environmentId">,
    event: TerminalAttachStreamEvent,
  ): void {
    if (event.type === "snapshot") {
      syncSnapshot(target, event.snapshot);
      return;
    }

    const knownTarget = getKnownTerminalSessionTarget({
      environmentId: target.environmentId,
      threadId: ThreadId.make(event.threadId),
      terminalId: event.terminalId,
    });
    if (knownTarget === null) {
      return;
    }

    const current = getBuffer(knownTarget);
    switch (event.type) {
      case "restarted":
        setBuffer(knownTarget, bufferFromSnapshot(event.snapshot, maxBufferBytes));
        return;
      case "output":
        setBuffer(knownTarget, {
          ...current,
          buffer: trimBufferToBytes(`${current.buffer}${event.data}`, maxBufferBytes),
          status: current.status === "closed" ? "running" : current.status,
          error: null,
          version: current.version + 1,
        });
        return;
      case "cleared":
        setBuffer(knownTarget, {
          ...current,
          buffer: "",
          error: null,
          version: current.version + 1,
        });
        return;
      case "exited":
        setBuffer(knownTarget, {
          ...current,
          status: "exited",
          error: null,
          version: current.version + 1,
        });
        return;
      case "closed":
        setBuffer(knownTarget, {
          ...current,
          status: "closed",
          error: null,
          version: current.version + 1,
        });
        return;
      case "error":
        setBuffer(knownTarget, {
          ...current,
          status: "error",
          error: event.message,
          version: current.version + 1,
        });
        return;
      case "activity":
        return;
    }
  }

  function invalidate(target?: TerminalSessionTarget): void {
    if (target) {
      const knownTarget = getKnownTerminalSessionTarget(target);
      if (knownTarget !== null) {
        const targetKey = keyFromKnownTarget(knownTarget);
        const next = { ...getMetadata(knownTarget.environmentId) };
        delete next[targetKey];
        setMetadata(knownTarget.environmentId, next);
        setBuffer(knownTarget, EMPTY_TERMINAL_BUFFER_STATE);
      }
      return;
    }

    for (const environmentId of knownTerminalMetadataEnvironmentIds) {
      setMetadata(environmentId, {});
    }
    knownTerminalMetadataEnvironmentIds.clear();
    for (const target of knownTerminalBufferTargets.values()) {
      setBuffer(target, EMPTY_TERMINAL_BUFFER_STATE);
    }
    knownTerminalBufferTargets.clear();
  }

  function invalidateEnvironment(environmentId: EnvironmentId): void {
    setMetadata(environmentId, {});
    knownTerminalMetadataEnvironmentIds.delete(environmentId);

    const prefix = `${environmentId}:`;
    for (const [key, target] of knownTerminalBufferTargets) {
      if (key.startsWith(prefix)) {
        setBuffer(target, EMPTY_TERMINAL_BUFFER_STATE);
      }
    }
  }

  function reset(): void {
    invalidate();
  }

  function listSessions(
    filter?: Partial<KnownTerminalSessionTarget>,
  ): ReadonlyArray<KnownTerminalSession> {
    if (filter?.environmentId) {
      return listKnownSessionsFromMetadata(getMetadata(filter.environmentId), getBuffer, filter);
    }

    return pipe(
      knownTerminalMetadataEnvironmentIds,
      Arr.fromIterable,
      Arr.flatMap((environmentId) =>
        listKnownSessionsFromMetadata(getMetadata(environmentId), getBuffer, filter),
      ),
    );
  }

  function subscribeMetadata(input: {
    readonly environmentId: EnvironmentId;
    readonly client: TerminalMetadataClient;
    readonly options?: { readonly onResubscribe?: () => void };
  }): () => void {
    return input.client.terminal.onMetadata(
      (event) => applyMetadataEvent({ environmentId: input.environmentId }, event),
      input.options,
    );
  }

  function attach(input: {
    readonly environmentId: EnvironmentId;
    readonly client: TerminalAttachClient;
    readonly terminal: TerminalAttachInput;
    readonly onSnapshot?: (snapshot: TerminalSessionSnapshot) => void;
    readonly onEvent?: (event: TerminalAttachStreamEvent) => void;
    readonly options?: { readonly onResubscribe?: () => void };
  }): () => void {
    return input.client.terminal.attach(
      input.terminal,
      (event) => {
        applyAttachEvent({ environmentId: input.environmentId }, event);
        input.onEvent?.(event);
        if (event.type === "snapshot") {
          input.onSnapshot?.(event.snapshot);
        }
      },
      input.options,
    );
  }

  return {
    attach,
    getSnapshot,
    invalidate,
    invalidateEnvironment,
    listSessions,
    subscribeMetadata,
    reset,
  };
}
