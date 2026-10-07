// @effect-diagnostics nodeBuiltinImport:off -- Each plugin child gets an extra fd 3 pipe, which needs Node's child_process.
/**
 * Runs each enabled plugin in its own child process.
 *
 * A child starts the first time a plugin is invoked, never at enable time, so
 * zero enabled (or zero used) plugins means zero processes. Each child gets a
 * V8 heap limit, a minimal environment, and a byte-bounded JSON line channel
 * on fd 3; the server decodes everything it reads and kills a child that
 * sends anything malformed or oversized. The server stops reading a child
 * whose decoded-but-unhandled lines reach `maxMessageBytes`, so a chatty
 * plugin is slowed down rather than buffered; the child then drops its logs,
 * never its results.
 *
 * A call that outlives its deadline, or whose caller is interrupted, is
 * cancelled cooperatively: the plugin's handler signal aborts and the child
 * has `cancelGrace` to answer. A child that cannot answer (a synchronous loop
 * never reads the cancel) is killed. Unexpected exits back the plugin off
 * with doubling delays; more than `maxRestarts` consecutive failures park it
 * in `quarantined` until `resume`. Disabling a plugin revokes its
 * registration at once: in-flight calls and calls still waiting for
 * activation fail, nothing new is sent, and no result produced after that
 * point reaches a caller. The supervisor owns a stopping process until it has
 * exited, even if the caller that disabled it goes away.
 *
 * A plugin can also call the server: capabilities serve host methods (such
 * as `settings.get`) with `serveHostMethod`, and the supervisor runs each
 * call off the child's read loop, at most `PLUGIN_MAX_HOST_CALLS` at a time
 * per child. Host calls belong to the generation that made them: once it is
 * revoked or its process exits, new calls are refused, calls being served
 * are interrupted (disable returns only after they have ended), and no
 * result reaches the child. Answers wait while the child has more than
 * `maxMessageBytes` of earlier messages unread, and so does the read loop
 * before it takes the next call, so a child that stops reading stops being
 * read instead of growing the server's write buffer.
 *
 * Plugins are trusted OS-user code. The process boundary protects the
 * server's availability, not its data.
 */
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";

import type { PluginHostState, PluginId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  decodePluginChildMessage,
  encodePluginHostMessage,
  PluginHandlerName,
  type PluginHostMessage,
  type PluginLogLevel,
} from "./PluginIpc.ts";
import {
  DEFAULT_PLUGIN_IPC_MAX_BYTES,
  PLUGIN_IPC_FD,
  PLUGIN_IPC_MAX_BYTES_LIMIT,
  PLUGIN_MAX_HOST_CALLS,
  makeLineDecoder,
  makeReadBudget,
} from "./pluginIpcFraming.ts";
import type { PluginRegistration } from "./PluginManifestLoader.ts";

/** Hidden CLI command that bin.ts routes to the plugin child runtime. */
const PLUGIN_HOST_COMMAND = "__plugin-host";

export interface PluginSupervisorOptions {
  readonly heapLimitMb: number;
  readonly maxMessageBytes: number;
  readonly activationTimeout: Duration.Input;
  readonly callTimeout: Duration.Input;
  readonly cancelGrace: Duration.Input;
  readonly stopGrace: Duration.Input;
  /** In-flight calls per plugin, counting cancelled calls the plugin has not answered yet. */
  readonly maxConcurrentCalls: number;
  /** Plugin processes alive at once across the environment. */
  readonly maxRunningPlugins: number;
  /** Consecutive failures that still restart; one more quarantines. */
  readonly maxRestarts: number;
  readonly restartBackoff: Duration.Input;
  readonly maxRestartBackoff: Duration.Input;
  /** A child that ran this long before failing starts a fresh failure count. */
  readonly stableUptime: Duration.Input;
}

const defaultPluginSupervisorOptions: PluginSupervisorOptions = {
  heapLimitMb: 256,
  maxMessageBytes: DEFAULT_PLUGIN_IPC_MAX_BYTES,
  activationTimeout: Duration.seconds(10),
  callTimeout: Duration.seconds(30),
  cancelGrace: Duration.seconds(2),
  stopGrace: Duration.seconds(2),
  maxConcurrentCalls: 16,
  maxRunningPlugins: 16,
  maxRestarts: 3,
  restartBackoff: Duration.seconds(1),
  maxRestartBackoff: Duration.seconds(30),
  stableUptime: Duration.minutes(1),
};

export class PluginAlreadyEnabledError extends Schema.TaggedError<PluginAlreadyEnabledError>()(
  "PluginAlreadyEnabledError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is already enabled.`;
  }
}

export class PluginNotEnabledError extends Schema.TaggedError<PluginNotEnabledError>()(
  "PluginNotEnabledError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is not enabled.`;
  }
}

class PluginUnavailableError extends Schema.TaggedError<PluginUnavailableError>()(
  "PluginUnavailableError",
  { pluginId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is unavailable: ${this.reason}`;
  }
}

class PluginCrashedError extends Schema.TaggedError<PluginCrashedError>()("PluginCrashedError", {
  pluginId: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Plugin ${this.pluginId} stopped unexpectedly: ${this.reason}`;
  }
}

class PluginIncompatibleError extends Schema.TaggedError<PluginIncompatibleError>()(
  "PluginIncompatibleError",
  { pluginId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} cannot run on this server: ${this.reason}`;
  }
}

class PluginStoppedError extends Schema.TaggedError<PluginStoppedError>()("PluginStoppedError", {
  pluginId: Schema.String,
}) {
  override get message(): string {
    return `Plugin ${this.pluginId} was stopped before the call finished.`;
  }
}

class PluginTimeoutError extends Schema.TaggedError<PluginTimeoutError>()("PluginTimeoutError", {
  pluginId: Schema.String,
  handler: Schema.String,
  timeoutMs: Schema.Number,
}) {
  override get message(): string {
    return `Plugin ${this.pluginId} did not answer "${this.handler}" within ${this.timeoutMs}ms.`;
  }
}

class PluginCallFailedError extends Schema.TaggedError<PluginCallFailedError>()(
  "PluginCallFailedError",
  { pluginId: Schema.String, handler: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} failed "${this.handler}": ${this.reason}`;
  }
}

class PluginBusyError extends Schema.TaggedError<PluginBusyError>()("PluginBusyError", {
  pluginId: Schema.String,
  limit: Schema.Number,
}) {
  override get message(): string {
    return `Plugin ${this.pluginId} already has ${this.limit} calls in flight.`;
  }
}

class PluginPayloadTooLargeError extends Schema.TaggedError<PluginPayloadTooLargeError>()(
  "PluginPayloadTooLargeError",
  { pluginId: Schema.String, bytes: Schema.Number, limit: Schema.Number },
) {
  override get message(): string {
    return `The call to plugin ${this.pluginId} is ${this.bytes} bytes; the limit is ${this.limit}.`;
  }
}

export type PluginInvokeError =
  | PluginNotEnabledError
  | PluginUnavailableError
  | PluginCrashedError
  | PluginIncompatibleError
  | PluginStoppedError
  | PluginTimeoutError
  | PluginCallFailedError
  | PluginBusyError
  | PluginPayloadTooLargeError;

/** A host method's refusal; `message` reaches the plugin, so it must not carry secrets. */
export class PluginHostCallError extends Schema.TaggedError<PluginHostCallError>()(
  "PluginHostCallError",
  { message: Schema.String },
) {}

/**
 * Serves one host method for the plugin whose registration made the call.
 * The call is interrupted when that generation is revoked; a method that
 * writes runs `admitted` right before committing, after any wait.
 */
export type PluginHostMethod = (call: {
  readonly registration: PluginRegistration;
  readonly input: Schema.Json;
  /** Fails once the calling generation is revoked or its process has exited. */
  readonly admitted: Effect.Effect<void, PluginHostCallError>;
}) => Effect.Effect<Schema.Json, PluginHostCallError>;

export type PluginSupervisorEvent =
  | { readonly _tag: "StateChanged"; readonly pluginId: PluginId; readonly state: PluginHostState }
  | {
      readonly _tag: "Log";
      readonly pluginId: PluginId;
      readonly level: PluginLogLevel;
      readonly message: string;
    };

type CallOutcome = Exit.Exit<Schema.Json, PluginInvokeError>;

interface PendingCall {
  readonly handler: string;
  readonly deferred: Deferred.Deferred<Schema.Json, PluginInvokeError>;
}

type ChildEvent =
  | { readonly _tag: "Line"; readonly line: string; readonly bytes: number }
  | { readonly _tag: "Overflow" }
  | { readonly _tag: "Exited"; readonly code: number | null; readonly signal: string | null }
  /** fd 3 and stderr have closed, so every line and the stderr tail have been read. */
  | { readonly _tag: "Drained" };

interface Child {
  readonly pluginId: PluginId;
  readonly process: NodeChildProcess.ChildProcess;
  readonly channel: NodeStream.Duplex;
  readonly startedAt: number;
  readonly ready: Deferred.Deferred<
    void,
    PluginCrashedError | PluginIncompatibleError | PluginStoppedError
  >;
  readonly exited: Deferred.Deferred<void>;
  readonly pending: Map<number, PendingCall>;
  /** Cancelled calls whose answer has not arrived yet. */
  readonly settling: Map<number, Deferred.Deferred<void>>;
  nextRequestId: number;
  stopping: boolean;
  /** The child reported code that cannot load here; set before it is killed. */
  incompatible: string | undefined;
  killReason: string | undefined;
  stderrTail: string;
  /** V8 reported reaching the heap limit; its message can scroll out of the tail. */
  outOfMemory: boolean;
  /** Host calls from this child still being served. */
  hostCalls: number;
  /** Owns the fibers serving this child's host calls; closed on revocation and exit. */
  readonly hostWork: Scope.Closeable;
  /** One host-call answer at a time waits for the child to read earlier messages. */
  readonly replies: Semaphore.Semaphore;
  /** Set while answers wait for the child to read; logged once per episode. */
  backedUp: boolean;
}

interface Entry {
  readonly registration: PluginRegistration;
  readonly pluginId: PluginId;
  state: PluginHostState;
  /** Set by disable; a removed entry never starts, admits, or reports again. */
  removed: boolean;
  failures: number;
  child: Child | undefined;
  starting: Deferred.Deferred<Child, PluginInvokeError> | undefined;
}

const STDERR_TAIL_BYTES = 4096;
const STOPPED_MESSAGE = "The plugin was stopped.";
// A grandchild that inherited stderr can hold it open after the plugin exits.
const DRAIN_TIMEOUT = Duration.millis(250);

const LOG_SEVERITY = { debug: "Debug", info: "Info", warn: "Warn", error: "Error" } as const;

// Enough for a trusted plugin to find its tools and temp space without
// inheriting the server's credentials or Node options.
const CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "LANG",
  "LC_ALL",
];

const isHandlerName = Schema.is(PluginHandlerName);

const isAlive = (child: Child) =>
  child.process.exitCode === null && child.process.signalCode === null;

const describeExit = (child: Child, code: number | null, signal: string | null, heapMb: number) => {
  if (child.outOfMemory) return `ran out of memory (heap limit ${heapMb} MB).`;
  const base = signal ? `was killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
  const lastLine = child.stderrTail.trim().split("\n").at(-1)?.slice(0, 300);
  return lastLine ? `${base}: ${lastLine}` : `${base}.`;
};

export class PluginSupervisor extends Context.Service<
  PluginSupervisor,
  {
    /** Registers a plugin; its process starts on first invoke. */
    readonly enable: (
      registration: PluginRegistration,
    ) => Effect.Effect<void, PluginAlreadyEnabledError>;
    /**
     * Stops the plugin's process, failing in-flight calls, and forgets it.
     * Idempotent: a repeat waits for a stop still in progress.
     */
    readonly disable: (pluginId: PluginId) => Effect.Effect<void>;
    /** Clears backoff, quarantine, or incompatibility so the next invoke starts a fresh process. */
    readonly resume: (pluginId: PluginId) => Effect.Effect<void, PluginNotEnabledError>;
    readonly invoke: (
      pluginId: PluginId,
      handler: string,
      input: Schema.Json,
      options?: { readonly timeout?: Duration.Input },
    ) => Effect.Effect<Schema.Json, PluginInvokeError>;
    readonly state: (pluginId: PluginId) => Effect.Effect<Option.Option<PluginHostState>>;
    /** Subscribes before returning, so no event after this point is missed. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<PluginSupervisorEvent>,
      never,
      Scope.Scope
    >;
    /** Answers plugins' `method` calls with `handler` until the scope closes. One handler per method. */
    readonly serveHostMethod: (
      method: string,
      handler: PluginHostMethod,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/plugins/PluginSupervisor") {}

export const make = Effect.fn("PluginSupervisor.make")(function* (
  overrides: Partial<PluginSupervisorOptions> = {},
) {
  const options = { ...defaultPluginSupervisorOptions, ...overrides };
  const maxMessageBytes = Math.min(options.maxMessageBytes, PLUGIN_IPC_MAX_BYTES_LIMIT);
  const activationTimeout = Duration.fromInputUnsafe(options.activationTimeout);
  const callTimeout = Duration.fromInputUnsafe(options.callTimeout);
  const cancelGrace = Duration.fromInputUnsafe(options.cancelGrace);
  const stopGrace = Duration.fromInputUnsafe(options.stopGrace);
  const restartBackoffMs = Duration.toMillis(Duration.fromInputUnsafe(options.restartBackoff));
  const maxRestartBackoffMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.maxRestartBackoff),
  );
  const stableUptimeMs = Duration.toMillis(Duration.fromInputUnsafe(options.stableUptime));

  const invocation = yield* resolveSelfInvocation();
  const hostEnvironment = yield* HostProcess.Environment;
  const heapFlag = `--max-old-space-size=${options.heapLimitMb}`;
  const childEnvironment: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of CHILD_ENV_KEYS) {
    const value = hostEnvironment[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  // The single executable takes no Node flags on its command line.
  const spawnArgs =
    invocation.entrypoint === undefined
      ? [PLUGIN_HOST_COMMAND]
      : [heapFlag, invocation.entrypoint, PLUGIN_HOST_COMMAND];
  if (invocation.entrypoint === undefined) childEnvironment.NODE_OPTIONS = heapFlag;

  const entries = new Map<PluginId, Entry>();
  const hostMethods = new Map<string, PluginHostMethod>();
  /** Every child process not yet exited, including ones whose plugin was disabled. */
  const children = new Set<Child>();
  /** Completes once a disabled plugin's processes have all exited. */
  const stops = new Map<PluginId, Deferred.Deferred<void>>();
  const events = yield* PubSub.sliding<PluginSupervisorEvent>(1024);
  // Child readers and timers live here and end after every child has stopped.
  const fibers = yield* Scope.make();

  const setState = (entry: Entry, state: PluginHostState) =>
    Effect.suspend(() => {
      if (entry.removed) return Effect.void;
      entry.state = state;
      return PubSub.publish(events, { _tag: "StateChanged", pluginId: entry.pluginId, state });
    });

  const kill = (child: Child, reason: string) => {
    child.killReason ??= reason;
    if (isAlive(child)) child.process.kill("SIGKILL");
  };

  /** Sends a message, or says why it cannot be sent. */
  const write = (child: Child, message: PluginHostMessage) => {
    const encoded = encodePluginHostMessage(message);
    if (Exit.isFailure(encoded)) return { _tag: "invalid" as const };
    const bytes = Buffer.byteLength(encoded.value);
    if (bytes > maxMessageBytes) return { _tag: "tooLarge" as const, bytes };
    if (!child.channel.destroyed) child.channel.write(`${encoded.value}\n`);
    return undefined;
  };

  const recordFailure = Effect.fnUntraced(function* (
    entry: Entry,
    startedAt: number,
    reason: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    entry.failures = now - startedAt >= stableUptimeMs ? 1 : entry.failures + 1;
    if (entry.failures > options.maxRestarts) {
      yield* Effect.logWarning("Plugin quarantined", { pluginId: entry.pluginId, reason });
      return yield* setState(entry, {
        _tag: "quarantined",
        failures: entry.failures,
        reason: reason.slice(0, 1000),
      });
    }
    const delay = Math.min(restartBackoffMs * 2 ** (entry.failures - 1), maxRestartBackoffMs);
    const backoff: PluginHostState = {
      _tag: "backoff",
      failures: entry.failures,
      reason: reason.slice(0, 1000),
      retryAt: DateTime.formatIso(DateTime.makeUnsafe(now + delay)),
    };
    yield* Effect.logWarning("Plugin failed; backing off", {
      pluginId: entry.pluginId,
      reason,
      delayMs: delay,
    });
    yield* setState(entry, backoff);
    yield* Effect.sleep(Duration.millis(delay)).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          entry.state === backoff ? setState(entry, { _tag: "idle" }) : Effect.void,
        ),
      ),
      Effect.forkIn(fibers, { startImmediately: true }),
    );
  });

  const hasRoom = (child: Child) =>
    child.channel.destroyed || child.channel.writableLength < maxMessageBytes;

  /** Waits until the child has read enough of what was sent to it, or can no longer read. */
  const awaitRoom = (child: Child) =>
    Effect.suspend(() => {
      if (hasRoom(child) || child.stopping) return Effect.void;
      const waiting = Effect.callback<void>((resume) => {
        const channel = child.channel;
        const done = () => {
          cleanup();
          resume(Effect.void);
        };
        const cleanup = () => {
          channel.off("drain", done);
          channel.off("close", done);
        };
        channel.on("drain", done);
        channel.on("close", done);
        if (hasRoom(child)) done();
        return Effect.sync(cleanup);
      }).pipe(Effect.raceFirst(Deferred.await(child.exited)));
      if (child.backedUp) return waiting;
      child.backedUp = true;
      return Effect.logWarning("Plugin is not reading the server's answers; waiting", {
        pluginId: child.pluginId,
        unreadBytes: child.channel.writableLength,
      }).pipe(Effect.andThen(waiting));
    }).pipe(Effect.ensuring(Effect.sync(() => (child.backedUp = !hasRoom(child)))));

  const hostCallFailed = (requestId: number, message: string): PluginHostMessage => ({
    _tag: "HostCallFailed",
    requestId,
    message: message.slice(0, 2000),
  });

  /** Sends a host call's answer to a live child; a revoked generation only learns it was stopped. */
  const sendAnswer = (child: Child, requestId: number, answer: PluginHostMessage) => {
    if (!isAlive(child)) return;
    if (child.stopping) {
      // Never wait for a stopping child; it is killed if it does not exit.
      if (hasRoom(child)) write(child, hostCallFailed(requestId, STOPPED_MESSAGE));
      return;
    }
    const unsent = write(child, answer);
    if (unsent)
      write(
        child,
        hostCallFailed(
          requestId,
          unsent._tag === "tooLarge"
            ? `The answer exceeds ${maxMessageBytes} bytes.`
            : "The answer is not JSON.",
        ),
      );
  };

  const answer = (child: Child, requestId: number, message: PluginHostMessage) =>
    child.replies.withPermit(
      awaitRoom(child).pipe(
        Effect.andThen(Effect.sync(() => sendAnswer(child, requestId, message))),
      ),
    );

  const outcomeMessage = (
    requestId: number,
    outcome: Exit.Exit<Schema.Json, PluginHostCallError>,
  ): PluginHostMessage =>
    Exit.isSuccess(outcome)
      ? { _tag: "HostCallSucceeded", requestId, value: outcome.value }
      : hostCallFailed(
          requestId,
          Exit.findErrorOption(outcome).pipe(
            Option.match({
              onNone: () => "The server could not answer.",
              onSome: (error) => error.message,
            }),
          ),
        );

  /** Whether host calls from `child` may still start or commit. */
  const isAdmitted = (entry: Entry, child: Child) =>
    !entry.removed && !child.stopping && entry.child === child && isAlive(child);

  /** Runs a host call outside the read loop, owned by the child's generation. */
  const serveHostCall = (
    entry: Entry,
    child: Child,
    requestId: number,
    method: string,
    input: Schema.Json,
  ) => {
    const refuse = (message: string) =>
      answer(child, requestId, hostCallFailed(requestId, message));
    if (!isAdmitted(entry, child)) return refuse(STOPPED_MESSAGE);
    const handler = hostMethods.get(method);
    if (!handler) return refuse(`This server has no method "${method}".`);
    if (child.hostCalls >= PLUGIN_MAX_HOST_CALLS)
      return refuse(`${PLUGIN_MAX_HOST_CALLS} calls to the server are already in flight.`);
    child.hostCalls++;
    const admitted = Effect.suspend(() =>
      isAdmitted(entry, child)
        ? Effect.void
        : Effect.fail(new PluginHostCallError({ message: STOPPED_MESSAGE })),
    );
    return Effect.suspend(() =>
      handler({ registration: entry.registration, input, admitted }),
    ).pipe(
      Effect.exit,
      Effect.flatMap((outcome) => answer(child, requestId, outcomeMessage(requestId, outcome))),
      Effect.onInterrupt(() =>
        Effect.sync(() => sendAnswer(child, requestId, hostCallFailed(requestId, STOPPED_MESSAGE))),
      ),
      Effect.ensuring(Effect.sync(() => child.hostCalls--)),
      Effect.forkIn(child.hostWork, { startImmediately: true }),
      Effect.asVoid,
    );
  };

  const handleLine = Effect.fnUntraced(function* (entry: Entry, child: Child, line: string) {
    const decoded = decodePluginChildMessage(line);
    if (Exit.isFailure(decoded)) return kill(child, "sent a malformed IPC message.");
    const message = decoded.value;
    switch (message._tag) {
      case "Ready":
        yield* Deferred.succeed(child.ready, undefined);
        return;
      case "ActivationFailed":
        // The exit fails activation, after the state reflects the failure.
        return kill(child, `activation failed: ${message.message}`);
      case "Incompatible":
        child.incompatible = message.message;
        return kill(child, message.message);
      case "Succeeded":
      case "Failed": {
        const pending = child.pending.get(message.requestId);
        if (pending) {
          child.pending.delete(message.requestId);
          yield* message._tag === "Succeeded"
            ? Deferred.succeed(pending.deferred, message.value)
            : Deferred.fail(
                pending.deferred,
                new PluginCallFailedError({
                  pluginId: entry.pluginId,
                  handler: pending.handler,
                  reason: message.message,
                }),
              );
          return;
        }
        const settling = child.settling.get(message.requestId);
        child.settling.delete(message.requestId);
        if (settling) yield* Deferred.succeed(settling, undefined);
        return;
      }
      case "Log":
        yield* Effect.logWithLevel(LOG_SEVERITY[message.level])(message.message).pipe(
          Effect.annotateLogs({ pluginId: entry.pluginId, pluginLogLevel: message.level }),
        );
        yield* PubSub.publish(events, {
          _tag: "Log",
          pluginId: entry.pluginId,
          level: message.level,
          message: message.message,
        });
        return;
      case "Deactivated":
        return;
      case "HostCall":
        // A child that does not read its answers is not read either.
        yield* awaitRoom(child);
        return yield* serveHostCall(entry, child, message.requestId, message.method, message.input);
    }
  });

  const handleExit = Effect.fnUntraced(function* (
    entry: Entry,
    child: Child,
    code: number | null,
    signal: string | null,
  ) {
    // Host work of a dead process ends before anything else can run for this plugin.
    yield* Scope.close(child.hostWork, Exit.void);
    // Anything still unread from the dead process is discarded, including a stderr
    // that a process it started still holds open after the drain timeout.
    child.channel.destroy();
    child.process.stderr?.destroy();
    const reason = child.killReason ?? describeExit(child, code, signal, options.heapLimitMb);
    const crashed = child.stopping
      ? new PluginStoppedError({ pluginId: entry.pluginId })
      : child.incompatible !== undefined
        ? new PluginIncompatibleError({ pluginId: entry.pluginId, reason: child.incompatible })
        : new PluginCrashedError({ pluginId: entry.pluginId, reason });
    // Settle the state first so a caller woken below already sees it.
    if (entry.child === child) entry.child = undefined;
    if (!entry.removed) {
      if (child.stopping) yield* setState(entry, { _tag: "idle" });
      // Retrying cannot help, so this spends none of the restart budget.
      else if (child.incompatible !== undefined)
        yield* setState(entry, { _tag: "incompatible", reason: child.incompatible.slice(0, 1000) });
      else yield* recordFailure(entry, child.startedAt, reason);
    }
    yield* Deferred.fail(child.ready, crashed);
    const pending = [...child.pending.values()];
    child.pending.clear();
    for (const call of pending) yield* Deferred.fail(call.deferred, crashed);
    const settling = [...child.settling.values()];
    child.settling.clear();
    for (const deferred of settling) yield* Deferred.succeed(deferred, undefined);
  });

  const spawnChild = Effect.fnUntraced(function* (entry: Entry) {
    const queue = yield* Queue.unbounded<ChildEvent>();
    const startedAt = yield* Clock.currentTimeMillis;
    const childProcess = NodeChildProcess.spawn(invocation.command, spawnArgs, {
      cwd: entry.registration.directory,
      env: childEnvironment,
      // fd 3 must be overlapped on Windows for the child to open it as a socket.
      stdio: ["ignore", "ignore", "pipe", "overlapped"],
      windowsHide: true,
    });
    const channel = childProcess.stdio[PLUGIN_IPC_FD] as NodeStream.Duplex;
    const child: Child = {
      pluginId: entry.pluginId,
      process: childProcess,
      channel,
      startedAt,
      ready: Deferred.makeUnsafe(),
      exited: Deferred.makeUnsafe(),
      pending: new Map(),
      settling: new Map(),
      nextRequestId: 0,
      stopping: false,
      incompatible: undefined,
      killReason: undefined,
      stderrTail: "",
      outOfMemory: false,
      hostCalls: 0,
      hostWork: Scope.forkUnsafe(fibers, "parallel"),
      replies: Semaphore.makeUnsafe(1),
      backedUp: false,
    };
    // Stream errors follow the child's death; its exit carries the outcome. A
    // child that drops fd 3 but lives on is killed when a call cannot settle.
    channel.on("error", () => {});
    childProcess.stderr?.on("error", () => {});
    childProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = child.stderrTail + chunk.toString("utf8");
      child.outOfMemory ||= /heap limit|heap out of memory/i.test(text);
      child.stderrTail = text.slice(-STDERR_TAIL_BYTES);
    });
    const budget = makeReadBudget({
      maxBytes: maxMessageBytes,
      pause: () => channel.pause(),
      resume: () => channel.resume(),
    });
    channel.on(
      "data",
      makeLineDecoder({
        maxBytes: maxMessageBytes,
        onLine: (line, bytes) => {
          budget.hold(bytes);
          Queue.offerUnsafe(queue, { _tag: "Line", line, bytes });
        },
        onOverflow: () => Queue.offerUnsafe(queue, { _tag: "Overflow" }),
      }),
    );
    let openStreams = 2;
    const onStreamClosed = () => {
      if (--openStreams === 0) Queue.offerUnsafe(queue, { _tag: "Drained" });
    };
    channel.once("close", onStreamClosed);
    if (childProcess.stderr) childProcess.stderr.once("close", onStreamClosed);
    else onStreamClosed();
    children.add(child);
    const onExit = (code: number | null, signal: string | null) => {
      if (!children.delete(child)) return;
      Deferred.doneUnsafe(child.exited, Exit.void);
      Queue.offerUnsafe(queue, { _tag: "Exited", code, signal });
    };
    childProcess.on("exit", onExit);
    childProcess.on("error", (error) => {
      child.killReason ??= `could not start: ${error.message}`;
      if (childProcess.pid === undefined) onExit(null, null);
    });

    yield* Effect.gen(function* () {
      let exit: { readonly code: number | null; readonly signal: string | null } | undefined;
      let drained = false;
      while (true) {
        const event = yield* Queue.take(queue);
        if (event._tag === "Line") {
          yield* handleLine(entry, child, event.line);
          budget.release(event.bytes);
        } else if (event._tag === "Overflow")
          kill(child, `sent an IPC message larger than ${maxMessageBytes} bytes.`);
        else if (event._tag === "Drained") drained = true;
        else {
          exit = event;
          yield* Effect.sleep(DRAIN_TIMEOUT).pipe(
            Effect.andThen(Queue.offer(queue, { _tag: "Drained" })),
            Effect.forkIn(fibers, { startImmediately: true }),
          );
        }
        if (exit && drained) return yield* handleExit(entry, child, exit.code, exit.signal);
      }
    }).pipe(Effect.forkIn(fibers));
    return child;
  });

  /** Marks a disabled plugin's child as stopping and fails everyone waiting on it. */
  const revokeChild = (entry: Entry, child: Child) => {
    child.stopping = true;
    const stopped = new PluginStoppedError({ pluginId: entry.pluginId });
    Deferred.doneUnsafe(child.ready, Exit.fail(stopped));
    for (const call of child.pending.values())
      Deferred.doneUnsafe(call.deferred, Exit.fail(stopped));
    child.pending.clear();
  };

  /**
   * Starts the plugin's process if needed and waits until it has activated.
   * Claiming a start through publishing its outcome is uninterruptible, so an
   * interrupted starter never strands the calls waiting on its start.
   */
  const ensureChild = Effect.fnUntraced(function* (entry: Entry) {
    const claim = yield* Effect.sync(() => {
      if (entry.child && !entry.starting) return { _tag: "running" as const, child: entry.child };
      if (entry.starting) return { _tag: "wait" as const, deferred: entry.starting };
      // A disabled plugin's process counts until it has exited.
      let running = children.size;
      for (const other of entries.values()) if (other.starting && !other.child) running++;
      if (running >= options.maxRunningPlugins) return { _tag: "limit" as const };
      for (const other of children)
        if (other.pluginId === entry.pluginId) return { _tag: "previous" as const };
      const deferred = Deferred.makeUnsafe<Child, PluginInvokeError>();
      entry.starting = deferred;
      return { _tag: "start" as const, deferred };
    });
    if (claim._tag === "running") return claim.child;
    if (claim._tag === "wait") return yield* Effect.interruptible(Deferred.await(claim.deferred));
    if (claim._tag === "limit")
      return yield* new PluginUnavailableError({
        pluginId: entry.pluginId,
        reason: `${options.maxRunningPlugins} plugin processes are already running.`,
      });
    if (claim._tag === "previous")
      return yield* new PluginUnavailableError({
        pluginId: entry.pluginId,
        reason: "its previous process is still stopping.",
      });

    const started = yield* Effect.gen(function* () {
      yield* setState(entry, { _tag: "starting" });
      if (entry.removed) return yield* new PluginStoppedError({ pluginId: entry.pluginId });
      const child = yield* spawnChild(entry);
      entry.child = child;
      if (entry.removed) revokeChild(entry, child);
      const { manifest, entryPath } = entry.registration;
      write(child, {
        _tag: "Activate",
        pluginId: manifest.id,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        entryPath,
        proposedApi: manifest.proposedApi,
        capabilities: manifest.capabilities,
        maxMessageBytes,
      });
      const activated = yield* Deferred.await(child.ready).pipe(
        Effect.timeoutOption(activationTimeout),
      );
      if (Option.isNone(activated)) {
        kill(child, `did not activate within ${Duration.toMillis(activationTimeout)}ms.`);
        yield* Deferred.await(child.exited);
        return yield* Deferred.await(child.ready).pipe(Effect.as(child));
      }
      // Ready can arrive after disable began; that generation never runs.
      if (child.stopping) return yield* new PluginStoppedError({ pluginId: entry.pluginId });
      yield* setState(entry, { _tag: "running" });
      return child;
    }).pipe(Effect.exit);
    entry.starting = undefined;
    yield* Deferred.done(claim.deferred, started);
    return yield* started;
  }, Effect.uninterruptible);

  const cancel = (entry: Entry, child: Child, requestId: number, handler: string) =>
    Effect.suspend(() => {
      if (!child.pending.delete(requestId)) return Effect.void;
      if (!isAlive(child)) return Effect.void;
      const settled = Deferred.makeUnsafe<void>();
      child.settling.set(requestId, settled);
      write(child, { _tag: "Cancel", requestId });
      return Deferred.await(settled).pipe(
        Effect.timeoutOption(cancelGrace),
        Effect.flatMap((answered) =>
          Effect.sync(() => {
            if (Option.isNone(answered) && entry.child === child)
              kill(
                child,
                `did not stop "${handler}" within ${Duration.toMillis(cancelGrace)}ms of cancellation.`,
              );
          }),
        ),
        Effect.forkIn(fibers, { startImmediately: true }),
        Effect.asVoid,
      );
    });

  const availability = (entry: Entry) => {
    const state = entry.state;
    if (state._tag === "backoff")
      return new PluginUnavailableError({
        pluginId: entry.pluginId,
        reason: `restarting after a failure at ${state.retryAt}: ${state.reason}`,
      });
    if (state._tag === "quarantined")
      return new PluginUnavailableError({
        pluginId: entry.pluginId,
        reason: `quarantined after ${state.failures} failures: ${state.reason}`,
      });
    if (state._tag === "incompatible")
      return new PluginIncompatibleError({ pluginId: entry.pluginId, reason: state.reason });
    return undefined;
  };

  const invoke: PluginSupervisor["Service"]["invoke"] = Effect.fn("PluginSupervisor.invoke")(
    function* (pluginId, handler, input, invokeOptions) {
      const entry = entries.get(pluginId);
      if (!entry) return yield* new PluginNotEnabledError({ pluginId });
      if (!isHandlerName(handler))
        return yield* new PluginCallFailedError({
          pluginId,
          handler,
          reason: "the handler name is invalid.",
        });
      const unavailable = availability(entry);
      if (unavailable) return yield* unavailable;
      const child = yield* ensureChild(entry);
      const timeout = Duration.fromInputUnsafe(invokeOptions?.timeout ?? callTimeout);

      const call = yield* Effect.sync(() => {
        if (entry.removed || child.stopping) return new PluginStoppedError({ pluginId });
        if (Deferred.isDoneUnsafe(child.exited))
          return new PluginUnavailableError({ pluginId, reason: "its process just stopped." });
        // A cancelled call holds its slot until the plugin answers it or exits.
        if (child.pending.size + child.settling.size >= options.maxConcurrentCalls)
          return new PluginBusyError({ pluginId, limit: options.maxConcurrentCalls });
        const requestId = ++child.nextRequestId;
        const deferred = Deferred.makeUnsafe<Schema.Json, PluginInvokeError>();
        child.pending.set(requestId, { handler, deferred });
        const unsent = write(child, { _tag: "Invoke", requestId, handler, input });
        if (unsent) child.pending.delete(requestId);
        if (unsent?._tag === "tooLarge")
          return new PluginPayloadTooLargeError({
            pluginId,
            bytes: unsent.bytes,
            limit: maxMessageBytes,
          });
        if (unsent)
          return new PluginCallFailedError({ pluginId, handler, reason: "the input is not JSON." });
        return { requestId, deferred };
      });
      if (!("requestId" in call)) return yield* call;

      const outcome: Option.Option<CallOutcome> = yield* Deferred.await(call.deferred).pipe(
        Effect.exit,
        Effect.timeoutOption(timeout),
        Effect.onInterrupt(() => cancel(entry, child, call.requestId, handler)),
      );
      if (Option.isNone(outcome)) {
        yield* cancel(entry, child, call.requestId, handler);
        return yield* new PluginTimeoutError({
          pluginId,
          handler,
          timeoutMs: Duration.toMillis(timeout),
        });
      }
      return yield* outcome.value;
    },
  );

  /** Deactivates a removed plugin's child, killing it after `stopGrace`, and waits for its exit. */
  const stopEntry = Effect.fnUntraced(function* (entry: Entry) {
    // Only reachable between claiming a start and spawning; the start then fails fast.
    if (!entry.child && entry.starting) yield* Deferred.await(entry.starting).pipe(Effect.ignore);
    const child = entry.child;
    if (!child || Deferred.isDoneUnsafe(child.exited)) return;
    revokeChild(entry, child);
    // The revoked generation's host work ends before its plugin is asked to deactivate.
    yield* Scope.close(child.hostWork, Exit.void);
    write(child, { _tag: "Deactivate" });
    const exited = yield* Deferred.await(child.exited).pipe(Effect.timeoutOption(stopGrace));
    if (Option.isNone(exited)) {
      kill(child, `did not stop within ${Duration.toMillis(stopGrace)}ms.`);
      yield* Deferred.await(child.exited);
    }
  });

  const disable = Effect.fn("PluginSupervisor.disable")(function* (pluginId: PluginId) {
    const entry = entries.get(pluginId);
    const previous = stops.get(pluginId);
    if (!entry) {
      // A retry after an interrupted disable waits for the same stop.
      if (previous) yield* Deferred.await(previous);
      return;
    }
    entries.delete(pluginId);
    entry.removed = true;
    if (entry.child) revokeChild(entry, entry.child);
    // The stop belongs to the supervisor: interrupting this caller only stops the wait.
    // It also covers an earlier generation still stopping, so done means every process exited.
    const stopped = Deferred.makeUnsafe<void>();
    stops.set(pluginId, stopped);
    yield* Effect.all([stopEntry(entry), previous ? Deferred.await(previous) : Effect.void], {
      concurrency: "unbounded",
      discard: true,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (stops.get(pluginId) === stopped) stops.delete(pluginId);
          Deferred.doneUnsafe(stopped, Exit.void);
        }),
      ),
      Effect.forkIn(fibers, { startImmediately: true, uninterruptible: true }),
    );
    yield* Deferred.await(stopped);
  });

  // Closing `fibers` waits for every stop in progress; anything left is killed.
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...entries.keys()], disable, { concurrency: "unbounded", discard: true }).pipe(
      Effect.andThen(Scope.close(fibers, Exit.void)),
      Effect.andThen(
        Effect.forEach(
          [...children],
          (child) => {
            kill(child, "the server stopped.");
            return Deferred.await(child.exited);
          },
          { discard: true },
        ),
      ),
    ),
  );

  return PluginSupervisor.of({
    enable: Effect.fn("PluginSupervisor.enable")(function* (registration) {
      const pluginId = registration.manifest.id;
      if (entries.has(pluginId)) return yield* new PluginAlreadyEnabledError({ pluginId });
      const entry: Entry = {
        registration,
        pluginId,
        state: { _tag: "idle" },
        removed: false,
        failures: 0,
        child: undefined,
        starting: undefined,
      };
      entries.set(pluginId, entry);
      yield* setState(entry, entry.state);
    }),
    disable,
    resume: Effect.fn("PluginSupervisor.resume")(function* (pluginId) {
      const entry = entries.get(pluginId);
      if (!entry) return yield* new PluginNotEnabledError({ pluginId });
      if (
        entry.state._tag !== "backoff" &&
        entry.state._tag !== "quarantined" &&
        entry.state._tag !== "incompatible"
      )
        return;
      entry.failures = 0;
      yield* setState(entry, { _tag: "idle" });
    }),
    invoke,
    state: (pluginId) => Effect.sync(() => Option.fromUndefinedOr(entries.get(pluginId)?.state)),
    subscribe: PubSub.subscribe(events),
    serveHostMethod: (method, handler) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (hostMethods.has(method)) throw new Error(`Host method ${method} is already served.`);
          hostMethods.set(method, handler);
        }),
        () => Effect.sync(() => hostMethods.delete(method)),
      ),
  });
});

export const layer = (overrides: Partial<PluginSupervisorOptions> = {}) =>
  Layer.effect(PluginSupervisor, make(overrides));
