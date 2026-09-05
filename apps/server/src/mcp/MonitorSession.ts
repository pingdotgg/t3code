import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class MonitorUnavailableError extends Schema.TaggedErrorClass<MonitorUnavailableError>()(
  "MonitorUnavailableError",
  { message: Schema.String },
) {}

export interface MonitorSession {
  readonly subscribe: (processId: string) => Effect.Effect<void, MonitorUnavailableError>;
  readonly unsubscribe: (processId: string) => Effect.Effect<void, MonitorUnavailableError>;
}

// Like McpProviderSession, the bridge lives only for the provider session.
// Keying by credential session ID prevents a replaced runtime receiving calls
// authenticated for its predecessor.
const sessions = new Map<string, MonitorSession>();

export const registerMonitorSession = (sessionId: string, session: MonitorSession) =>
  Effect.acquireRelease(
    Effect.sync(() => sessions.set(sessionId, session)),
    () =>
      Effect.sync(() => {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      }),
  );

export const invokeMonitorSession = Effect.fn("MonitorSession.invoke")(function* (
  sessionId: string,
  operation: keyof MonitorSession,
  processId: string,
) {
  const session = sessions.get(sessionId);
  if (!session)
    return yield* new MonitorUnavailableError({
      message: "Monitoring requires an active Codex 0.153.2 or later session.",
    });
  yield* session[operation](processId);
  return { processId, subscribed: operation === "subscribe" };
});
