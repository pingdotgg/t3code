import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export class MonitorUnavailableError extends Schema.TaggedErrorClass<MonitorUnavailableError>()(
  "MonitorUnavailableError",
  { sessionId: Schema.String },
) {
  override get message() {
    return `Monitoring requires an active Codex 0.153.2 or later session (${this.sessionId}).`;
  }
}

export class MonitorCapabilityError extends Schema.TaggedErrorClass<MonitorCapabilityError>()(
  "MonitorCapabilityError",
  {},
) {
  override get message() {
    return "Monitoring is unavailable for this provider session.";
  }
}

export class MonitorStoppedError extends Schema.TaggedErrorClass<MonitorStoppedError>()(
  "MonitorStoppedError",
  {},
) {
  override get message() {
    return "Monitoring is unavailable or was stopped. Start a new turn to resume.";
  }
}

export class MonitorProcessMissingError extends Schema.TaggedErrorClass<MonitorProcessMissingError>()(
  "MonitorProcessMissingError",
  { processId: Schema.String },
) {
  override get message() {
    return `No running background process with session ID ${this.processId}. Launch a watcher with exec_command first.`;
  }
}

export class MonitorStartError extends Schema.TaggedErrorClass<MonitorStartError>()(
  "MonitorStartError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not schedule the background monitor.";
  }
}

export const MonitorError = Schema.Union([
  MonitorStartError,
  MonitorUnavailableError,
  MonitorCapabilityError,
  MonitorStoppedError,
  MonitorProcessMissingError,
]);

export interface MonitorSession {
  readonly start: (
    command: ReadonlyArray<string>,
  ) => Effect.Effect<{ monitorId: string; status: "scheduled" }, typeof MonitorError.Type>;
  readonly subscribe: (processId: string) => Effect.Effect<void, typeof MonitorError.Type>;
  readonly unsubscribe: (processId: string) => Effect.Effect<void, typeof MonitorError.Type>;
}

// Like McpProviderSession, the bridge lives only for the provider session.
// Keying by credential session ID prevents a replaced runtime receiving calls
// authenticated for its predecessor.
export class MonitorSessions extends Context.Service<
  MonitorSessions,
  {
    readonly register: (
      sessionId: string,
      session: MonitorSession,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly invoke: (
      sessionId: string,
      operation: "subscribe" | "unsubscribe",
      processId: string,
    ) => Effect.Effect<{ processId: string; subscribed: boolean }, typeof MonitorError.Type>;
    readonly start: (
      sessionId: string,
      command: ReadonlyArray<string>,
    ) => Effect.Effect<{ monitorId: string; status: "scheduled" }, typeof MonitorError.Type>;
  }
>()("t3/mcp/MonitorSession/MonitorSessions") {}

export const make = Effect.sync(() => {
  const sessions = new Map<string, MonitorSession>();

  const register = (sessionId: string, session: MonitorSession) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        sessions.set(sessionId, session);
      }),
      () =>
        Effect.sync(() => {
          if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        }),
    );

  const invoke = Effect.fn("MonitorSession.invoke")(function* (
    sessionId: string,
    operation: "subscribe" | "unsubscribe",
    processId: string,
  ) {
    const session = sessions.get(sessionId);
    if (!session) return yield* new MonitorUnavailableError({ sessionId });
    yield* session[operation](processId);
    return { processId, subscribed: operation === "subscribe" };
  });
  const start = Effect.fn("MonitorSession.start")(function* (
    sessionId: string,
    command: ReadonlyArray<string>,
  ) {
    const session = sessions.get(sessionId);
    if (!session) return yield* new MonitorUnavailableError({ sessionId });
    return yield* session.start(command);
  });
  return { register, invoke, start };
});

export const layer = Layer.effect(MonitorSessions, make);
