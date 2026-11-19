// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off - Plain-TypeScript game bridge core (sockets, files, vendor HTTP), unit-tested without an Effect runtime; GameDevService wraps it.
import type {
  GameApprovalRequest,
  GameBridgeSession,
  GameCompileMessage,
  GameEngineId,
  GamePlayState,
  GameTimelineEntry,
  GameTimelineKind,
} from "@t3tools/contracts";
import { BRIDGE_PROTOCOL_VERSION, GAME_OPERATIONS, isGameOperation } from "@t3tools/shared/gameDevCatalog";
import { redactSecrets } from "@t3tools/shared/secretRedaction";

/**
 * Editor sessions connected through the bridge plugins, the commands waiting for them, and what
 * they reported. Plain TypeScript with an injected clock so protocol behavior is testable
 * without an editor; `GameBridgeHttp` puts it on a loopback socket.
 */

export interface BridgeHello {
  readonly protocol: number;
  readonly engine: GameEngineId;
  readonly editorVersion: string;
  readonly pluginVersion: string;
  /** Stable across script reloads (Unity domain reloads) so the session survives them. */
  readonly instanceId: string;
  readonly projectRoot: string | null;
  readonly projectName: string;
  /** Roblox: identifies the place so a binding to a project survives Studio restarts. */
  readonly placeKey: string | null;
  readonly operations: ReadonlyArray<string>;
  readonly playState: GamePlayState;
  /** Commands the editor is still running across a script reload, such as Play Mode tests. */
  readonly inflight?: ReadonlyArray<string>;
}

export interface BridgeCommand {
  readonly id: string;
  readonly operation: string;
  readonly args: Record<string, unknown>;
}

export interface BridgeResult {
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export type BridgeEvent =
  | { readonly type: "log"; readonly level: "info" | "warning" | "error"; readonly message: string }
  | { readonly type: "play_state"; readonly state: GamePlayState }
  | { readonly type: "compile"; readonly messages: ReadonlyArray<GameCompileMessage> }
  | { readonly type: "reloading" }
  | { readonly type: "test_result"; readonly summary: string; readonly passed: boolean };

export interface BridgeCapture {
  readonly captureId: string;
  readonly mimeType: string;
  readonly dataBase64: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly at: string;
  readonly source: "editor" | "window" | "blender" | "forgegui" | "file";
  readonly projectRoot: string | null;
}

export interface CallOutcome {
  readonly ok: boolean;
  readonly value: unknown;
  readonly error: string | null;
  readonly captureId: string | null;
}

interface PendingCall {
  readonly command: BridgeCommand;
  delivered: boolean;
  readonly resolve: (outcome: CallOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface SessionRecord {
  session: GameBridgeSession;
  readonly instanceId: string;
  placeKey: string | null;
  readonly queue: BridgeCommand[];
  readonly pending: Map<string, PendingCall>;
  waiter: ((commands: ReadonlyArray<BridgeCommand>) => void) | null;
  readonly timeline: GameTimelineEntry[];
  compile: ReadonlyArray<GameCompileMessage>;
  playtest: number;
  latestCaptureId: string | null;
}

export class BridgeHelloError extends Error {
  readonly status: 401 | 400 | 426;
  constructor(status: 401 | 400 | 426, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RegistryClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const SYSTEM_CLOCK: RegistryClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const TIMELINE_LIMIT = 2_000;
const CAPTURE_LIMIT = 30;
const CAPTURE_BYTES_LIMIT = 96 * 1024 * 1024;
export const POLL_TIMEOUT_MS = 20_000;
export const DISCONNECT_AFTER_MS = 45_000;
const FORGET_AFTER_MS = 30 * 60_000;
const MAX_MESSAGE_CHARS = 4_000;

const clean = (text: string) => redactSecrets(text.slice(0, MAX_MESSAGE_CHARS)).text;

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class GameBridgeRegistry {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #captures = new Map<string, BridgeCapture>();
  readonly #approvals = new Map<
    string,
    { readonly request: GameApprovalRequest; readonly resolve: (approved: boolean) => void; readonly timer: ReturnType<typeof setTimeout> }
  >();
  readonly #listeners = new Set<() => void>();

  private readonly token: () => string;
  private readonly bindings: { readonly resolvePlace: (placeKey: string) => string | null };
  private readonly clock: RegistryClock;

  constructor(
    token: () => string,
    bindings: { readonly resolvePlace: (placeKey: string) => string | null } = { resolvePlace: () => null },
    clock: RegistryClock = SYSTEM_CLOCK,
  ) {
    this.token = token;
    this.bindings = bindings;
    this.clock = clock;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed() {
    for (const listener of this.#listeners) listener();
  }

  #iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  authenticate(presented: string | null): boolean {
    const expected = this.token();
    if (presented === null || presented.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
    }
    return difference === 0;
  }

  hello(hello: BridgeHello): GameBridgeSession {
    if (hello.protocol !== BRIDGE_PROTOCOL_VERSION) {
      throw new BridgeHelloError(
        426,
        hello.protocol > BRIDGE_PROTOCOL_VERSION
          ? `This bridge plugin speaks protocol ${hello.protocol}; this Continuum speaks ${BRIDGE_PROTOCOL_VERSION}. Update Continuum.`
          : `This bridge plugin is older than Continuum (protocol ${hello.protocol}, expected ${BRIDGE_PROTOCOL_VERSION}). Reinstall it from Continuum's Game Development workspace.`,
      );
    }
    const operations = hello.operations.filter(isGameOperation);
    const existing = [...this.#sessions.values()].find((record) => record.instanceId === hello.instanceId);
    const now = this.#iso();
    const projectRoot =
      hello.projectRoot ?? (hello.placeKey ? this.bindings.resolvePlace(hello.placeKey) : null);
    if (existing) {
      const wasReloading = existing.session.state === "reloading";
      existing.session = {
        ...existing.session,
        editorVersion: hello.editorVersion,
        pluginVersion: hello.pluginVersion,
        projectRoot: projectRoot ?? existing.session.projectRoot,
        projectName: hello.projectName,
        operations,
        playState: hello.playState,
        state: "connected",
        lastSeenAt: now,
      };
      existing.placeKey = hello.placeKey;
      // A reload drops in-flight work; writes are not replayed, reads are.
      const inflight = new Set(hello.inflight ?? []);
      for (const pending of [...existing.pending.values()]) {
        if (!pending.delivered || inflight.has(pending.command.id)) continue;
        const spec = isGameOperation(pending.command.operation) ? GAME_OPERATIONS[pending.command.operation] : null;
        if (spec && !spec.writes) {
          pending.delivered = false;
          existing.queue.push(pending.command);
        } else {
          this.#settle(existing, pending.command.id, {
            ok: false,
            value: null,
            error: `${hello.engine === "unity" ? "Unity reloaded scripts" : "The editor reconnected"} while running ${pending.command.operation}. Inspect the scene before retrying, since it may have applied.`,
            captureId: null,
          });
        }
      }
      this.#record(existing, "connection", wasReloading ? "Editor reconnected after reloading scripts." : "Editor reconnected.", {});
      this.#changed();
      return existing.session;
    }
    const session: GameBridgeSession = {
      sessionId: nextId("gs"),
      engine: hello.engine,
      editorVersion: hello.editorVersion,
      pluginVersion: hello.pluginVersion,
      projectRoot,
      projectName: hello.projectName,
      state: "connected",
      playState: hello.playState,
      operations,
      connectedAt: now,
      lastSeenAt: now,
      compileErrorCount: 0,
    };
    const record: SessionRecord = {
      session,
      instanceId: hello.instanceId,
      placeKey: hello.placeKey,
      queue: [],
      pending: new Map(),
      waiter: null,
      timeline: [],
      compile: [],
      playtest: 0,
      latestCaptureId: null,
    };
    this.#sessions.set(session.sessionId, record);
    this.#record(record, "connection", `${hello.projectName} connected (${hello.engine} ${hello.editorVersion}).`, {});
    this.#changed();
    return session;
  }

  #touch(record: SessionRecord) {
    const wasDisconnected = record.session.state === "disconnected";
    record.session = { ...record.session, lastSeenAt: this.#iso(), state: record.session.state === "reloading" ? "reloading" : "connected" };
    if (wasDisconnected) this.#changed();
  }

  /** Resolves with the next commands, or an empty list after the long-poll timeout. */
  poll(sessionId: string): Promise<ReadonlyArray<BridgeCommand>> | null {
    const record = this.#sessions.get(sessionId);
    if (!record) return null;
    this.#touch(record);
    if (record.queue.length > 0) return Promise.resolve(this.#drain(record));
    record.waiter?.([]);
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => {
        if (record.waiter === finish) record.waiter = null;
        resolve([]);
      }, POLL_TIMEOUT_MS);
      const finish = (commands: ReadonlyArray<BridgeCommand>) => {
        this.clock.clearTimeout(timer);
        record.waiter = null;
        resolve(commands);
      };
      record.waiter = finish;
    });
  }

  #drain(record: SessionRecord): ReadonlyArray<BridgeCommand> {
    const commands = record.queue.splice(0, record.queue.length);
    for (const command of commands) {
      const pending = record.pending.get(command.id);
      if (pending) pending.delivered = true;
    }
    return commands;
  }

  results(sessionId: string, results: ReadonlyArray<BridgeResult>): boolean {
    const record = this.#sessions.get(sessionId);
    if (!record) return false;
    this.#touch(record);
    for (const result of results) {
      let captureId: string | null = null;
      let value = result.value ?? null;
      const capture = extractCapture(value);
      if (capture) {
        captureId = this.storeCapture({ ...capture, source: "editor", projectRoot: record.session.projectRoot });
        value = { ...(value as Record<string, unknown>), capture: undefined, captureId };
        record.latestCaptureId = captureId;
        this.#record(record, "capture", "Viewport captured.", { captureId });
      }
      this.#settle(record, result.id, {
        ok: result.ok,
        value,
        error: result.ok ? null : clean(result.error ?? "The editor reported an error."),
        captureId,
      });
    }
    return true;
  }

  #settle(record: SessionRecord, id: string, outcome: CallOutcome) {
    const pending = record.pending.get(id);
    if (!pending) return;
    this.clock.clearTimeout(pending.timer);
    record.pending.delete(id);
    // A command that gave up before the editor took it must not run later.
    const queued = record.queue.findIndex((command) => command.id === id);
    if (queued !== -1) record.queue.splice(queued, 1);
    pending.resolve(outcome);
  }

  events(sessionId: string, events: ReadonlyArray<BridgeEvent>): boolean {
    const record = this.#sessions.get(sessionId);
    if (!record) return false;
    this.#touch(record);
    for (const event of events) {
      switch (event.type) {
        case "log": {
          const kind: GameTimelineKind = event.level === "error" ? "error" : event.level === "warning" ? "warning" : "log";
          this.#record(record, kind, clean(event.message), {});
          break;
        }
        case "play_state": {
          if (event.state === record.session.playState) break;
          if (event.state === "playing" && record.session.playState === "edit") record.playtest += 1;
          record.session = { ...record.session, playState: event.state };
          this.#record(record, "play-state", playStateText(event.state), {});
          this.#changed();
          break;
        }
        case "compile": {
          record.compile = event.messages.slice(0, 200).map((message) => ({ ...message, message: clean(message.message) }));
          const errors = record.compile.filter((message) => message.severity === "error");
          record.session = { ...record.session, compileErrorCount: errors.length };
          this.#record(
            record,
            errors.length > 0 ? "build-error" : "log",
            errors.length > 0
              ? `${errors.length} compile error${errors.length === 1 ? "" : "s"}: ${errors[0]!.message}`
              : "Compiled without errors.",
            { ok: errors.length === 0 },
          );
          this.#changed();
          break;
        }
        case "reloading": {
          record.session = { ...record.session, state: "reloading" };
          this.#record(record, "connection", "Editor is reloading scripts.", {});
          this.#changed();
          break;
        }
        case "test_result": {
          this.#record(record, "test-result", clean(event.summary), { ok: event.passed });
          break;
        }
      }
    }
    return true;
  }

  goodbye(sessionId: string) {
    const record = this.#sessions.get(sessionId);
    if (!record) return;
    this.#disconnect(record, "The editor closed the connection.");
  }

  #disconnect(record: SessionRecord, reason: string) {
    record.session = { ...record.session, state: "disconnected" };
    record.waiter?.([]);
    for (const pending of [...record.pending.values()]) {
      this.#settle(record, pending.command.id, { ok: false, value: null, error: reason, captureId: null });
    }
    record.queue.length = 0;
    this.#record(record, "connection", reason, {});
    this.#changed();
  }

  /** Marks silent editors disconnected and forgets long-gone ones. */
  sweep() {
    const now = this.clock.now();
    for (const [id, record] of this.#sessions) {
      const silentFor = now - Date.parse(record.session.lastSeenAt);
      if (record.session.state !== "disconnected" && silentFor > DISCONNECT_AFTER_MS) {
        this.#disconnect(record, "The editor stopped responding.");
      } else if (record.session.state === "disconnected" && silentFor > FORGET_AFTER_MS) {
        this.#sessions.delete(id);
        this.#changed();
      }
    }
  }

  call(
    sessionId: string,
    operation: string,
    args: Record<string, unknown>,
    options: { readonly timeoutMs: number; readonly actor: "agent" | "user"; readonly summary: string },
  ): Promise<CallOutcome> {
    const record = this.#sessions.get(sessionId);
    if (!record || record.session.state === "disconnected") {
      return Promise.resolve({ ok: false, value: null, error: "That editor is not connected.", captureId: null });
    }
    if (!record.session.operations.includes(operation)) {
      return Promise.resolve({
        ok: false,
        value: null,
        error: `${record.session.projectName} (${record.session.engine}) does not support ${operation}. It supports: ${record.session.operations.join(", ")}.`,
        captureId: null,
      });
    }
    const command: BridgeCommand = { id: nextId("cmd"), operation, args };
    return new Promise<CallOutcome>((resolve) => {
      const timer = this.clock.setTimeout(
        () =>
          this.#settle(record, command.id, {
            ok: false,
            value: null,
            error: `The editor did not finish ${operation} within ${Math.round(options.timeoutMs / 1000)} s. It may still complete; inspect before retrying.`,
            captureId: null,
          }),
        options.timeoutMs,
      );
      record.pending.set(command.id, { command, delivered: false, resolve, timer });
      record.queue.push(command);
      if (record.waiter && record.session.state !== "reloading") record.waiter(this.#drain(record));
    }).then((outcome) => {
      this.#record(
        record,
        options.actor === "agent" ? "agent-action" : "user-action",
        `${clean(options.summary)}${outcome.ok ? "" : ` — failed: ${outcome.error}`}`,
        { operation, ok: outcome.ok, captureId: outcome.captureId },
      );
      return outcome;
    });
  }

  #record(
    record: SessionRecord,
    kind: GameTimelineKind,
    text: string,
    extra: { readonly operation?: string; readonly ok?: boolean; readonly captureId?: string | null },
  ) {
    record.timeline.push({
      id: nextId("tl"),
      at: this.#iso(),
      kind,
      text,
      playtest: record.session.playState === "playing" || record.session.playState === "paused" ? record.playtest : null,
      captureId: extra.captureId ?? null,
      operation: extra.operation ?? null,
      ok: extra.ok ?? null,
    });
    if (record.timeline.length > TIMELINE_LIMIT) record.timeline.splice(0, record.timeline.length - TIMELINE_LIMIT);
  }

  /** Adds an entry from outside the bridge, such as an asset import or a checkpoint. */
  note(projectRoot: string, kind: GameTimelineKind, text: string, captureId: string | null = null) {
    const record = this.#forProject(projectRoot);
    if (record) this.#record(record, kind, clean(text), { captureId });
  }

  storeCapture(capture: Omit<BridgeCapture, "captureId" | "at">): string {
    const captureId = nextId("cap");
    this.#captures.set(captureId, { ...capture, captureId, at: this.#iso() });
    let bytes = 0;
    for (const entry of this.#captures.values()) bytes += entry.dataBase64.length;
    for (const [id, entry] of this.#captures) {
      if (this.#captures.size <= CAPTURE_LIMIT && bytes <= CAPTURE_BYTES_LIMIT) break;
      bytes -= entry.dataBase64.length;
      this.#captures.delete(id);
    }
    return captureId;
  }

  capture(captureId: string): BridgeCapture | null {
    return this.#captures.get(captureId) ?? null;
  }

  sessions(): ReadonlyArray<GameBridgeSession> {
    return [...this.#sessions.values()].map((record) => record.session);
  }

  session(sessionId: string): GameBridgeSession | null {
    return this.#sessions.get(sessionId)?.session ?? null;
  }

  placeKey(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.placeKey ?? null;
  }

  bind(sessionId: string, projectRoot: string): GameBridgeSession | null {
    const record = this.#sessions.get(sessionId);
    if (!record) return null;
    record.session = { ...record.session, projectRoot };
    this.#record(record, "connection", `Bound to ${projectRoot}.`, {});
    this.#changed();
    return record.session;
  }

  #forProject(projectRoot: string): SessionRecord | null {
    const matching = [...this.#sessions.values()].filter(
      (record) => record.session.projectRoot !== null && sameOrInside(record.session.projectRoot, projectRoot),
    );
    return (
      matching.find((record) => record.session.state !== "disconnected") ??
      matching.sort((left, right) => right.session.lastSeenAt.localeCompare(left.session.lastSeenAt))[0] ??
      null
    );
  }

  /** The editor working on this project root (or a project inside it), live sessions first. */
  sessionForProject(projectRoot: string): GameBridgeSession | null {
    return this.#forProject(projectRoot)?.session ?? null;
  }

  projectState(projectRoot: string) {
    const record = this.#forProject(projectRoot);
    return record
      ? {
          session: record.session,
          timeline: record.timeline.slice(-400),
          compile: record.compile,
          latestCaptureId: record.latestCaptureId,
          playtests: record.playtest,
        }
      : null;
  }

  logs(sessionId: string, input: { readonly levels: ReadonlyArray<GameTimelineKind>; readonly contains: string | null; readonly limit: number; readonly playtest: number | "latest" | null }) {
    const record = this.#sessions.get(sessionId);
    if (!record) return [];
    const playtest = input.playtest === "latest" ? record.playtest : input.playtest;
    const needle = input.contains?.toLowerCase() ?? null;
    return record.timeline
      .filter(
        (entry) =>
          input.levels.includes(entry.kind) &&
          (playtest === null || entry.playtest === playtest) &&
          (needle === null || entry.text.toLowerCase().includes(needle)),
      )
      .slice(-input.limit);
  }

  compileMessages(sessionId: string): ReadonlyArray<GameCompileMessage> {
    return this.#sessions.get(sessionId)?.compile ?? [];
  }

  requestApproval(request: Omit<GameApprovalRequest, "approvalId" | "requestedAt">, timeoutMs: number): Promise<boolean> {
    const approvalId = nextId("ap");
    return new Promise<boolean>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.#approvals.delete(approvalId);
        this.#changed();
        resolve(false);
      }, timeoutMs);
      this.#approvals.set(approvalId, {
        request: { ...request, approvalId, requestedAt: this.#iso() },
        resolve,
        timer,
      });
      this.#changed();
    });
  }

  resolveApproval(approvalId: string, approve: boolean): boolean {
    const entry = this.#approvals.get(approvalId);
    if (!entry) return false;
    this.clock.clearTimeout(entry.timer);
    this.#approvals.delete(approvalId);
    entry.resolve(approve);
    if (entry.request.projectRoot) {
      this.note(entry.request.projectRoot, "user-action", `${approve ? "Approved" : "Denied"}: ${entry.request.summary}`);
    }
    this.#changed();
    return true;
  }

  approvals(projectRoot?: string): ReadonlyArray<GameApprovalRequest> {
    return [...this.#approvals.values()]
      .map((entry) => entry.request)
      .filter((request) => projectRoot === undefined || request.projectRoot === null || sameOrInside(request.projectRoot, projectRoot));
  }
}

function playStateText(state: GamePlayState): string {
  switch (state) {
    case "playing":
      return "Playtest started.";
    case "paused":
      return "Playtest paused.";
    case "edit":
      return "Playtest stopped.";
    default:
      return "Play state unknown.";
  }
}

function extractCapture(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  const capture = (value as { capture?: unknown }).capture;
  if (typeof capture !== "object" || capture === null) return null;
  const { mimeType, dataBase64, width, height } = capture as Record<string, unknown>;
  if (typeof dataBase64 !== "string" || dataBase64.length === 0) return null;
  return {
    mimeType: typeof mimeType === "string" ? mimeType : "image/png",
    dataBase64,
    width: typeof width === "number" ? width : null,
    height: typeof height === "number" ? height : null,
  };
}

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** True when `inner` is `outer` or below it. Case-insensitive, for Windows and macOS. */
export function sameOrInside(inner: string, outer: string): boolean {
  const a = normalizePath(inner);
  const b = normalizePath(outer);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
