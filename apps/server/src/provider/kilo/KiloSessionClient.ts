// @effect-diagnostics globalTimers:off - watchdog for the SDK async iterator; avoids a fiber and timer race per SSE record.
import { createKiloClient, type Event, type KiloClient, type Session } from "@kilocode/sdk/v2";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** Persist with the T3 session. A native id alone is not an account or workspace identity. */
const KiloSessionRef = Schema.Struct({
  instanceId: Schema.NonEmptyString,
  directory: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
});
export type KiloSessionRef = typeof KiloSessionRef.Type;

export class KiloSessionError extends Schema.TaggedError<KiloSessionError>()("KiloSessionError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "request_failed",
    "admission_unknown",
    "wrong_owner",
    "unsupported_version",
    "invalid_response",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Kilo ${this.operation} failed (${this.reason}).`;
  }
}

const Health = Schema.Struct({ healthy: Schema.Literal(true), version: Schema.Literal("7.8.3") });
const decodeHealth = Schema.decodeUnknownEffect(Health);

const SessionOwner = Schema.Struct({ id: Schema.NonEmptyString, directory: Schema.String });
const PendingOwners = Schema.Array(
  Schema.Struct({ id: Schema.NonEmptyString, sessionID: Schema.NonEmptyString }),
);
const EventEnvelope = Schema.Struct({
  type: Schema.NonEmptyString,
  properties: Schema.Record(Schema.String, Schema.Unknown),
});

const isStatusMap = Schema.is(
  Schema.Record(Schema.String, Schema.Struct({ type: Schema.Literals(["idle", "busy", "retry"]) })),
);
const isGeneration = Schema.is(
  Schema.Struct({
    info: Schema.Record(Schema.String, Schema.Unknown),
    parts: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
);
const isKiloSessionError = Schema.is(KiloSessionError);
const isSyncEnvelope = Schema.is(
  Schema.Struct({
    type: Schema.Literal("sync"),
    syncEvent: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
const isSessionOwner = Schema.is(SessionOwner);
const isPendingOwners = Schema.is(PendingOwners);
const isEventEnvelope = Schema.is(EventEnvelope);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

function sessionIdOf(event: Event): string | undefined | KiloSessionError {
  // The server also sends replication envelopes omitted from its generated Event union.
  // Ordinary session/message events follow these and remain the source for this stream.
  if (isSyncEnvelope(event)) return undefined;
  if (!isEventEnvelope(event)) {
    return new KiloSessionError({ operation: "event.subscribe", reason: "invalid_response" });
  }
  const properties = event.properties;
  let value: unknown;
  if ("sessionID" in properties) value = properties.sessionID;
  else if (event.type === "message.part.updated") {
    value = isRecord(properties.part) ? properties.part.sessionID : undefined;
  } else if (event.type === "message.updated") {
    value = isRecord(properties.info) ? properties.info.sessionID : undefined;
  } else if (
    event.type === "session.created" ||
    event.type === "session.updated" ||
    event.type === "session.deleted"
  ) {
    value = isRecord(properties.info) ? properties.info.id : undefined;
  } else if (event.type === "session.error") {
    return new KiloSessionError({ operation: "event.subscribe", reason: "request_failed" });
  } else {
    // Directory streams include global config, PTY and health events. Their `info`
    // fields are not session records and must not terminate unrelated sessions.
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    return new KiloSessionError({ operation: "event.subscribe", reason: "invalid_response" });
  }
  return value;
}

/**
 * One local Kilo provider instance and directory, using Kilo's SDK and auth/header conventions.
 * No ambient credentials, cloud routes, automatic retries of mutations, or global config writes.
 * The caller owns the server process and supplies its scoped loopback URL.
 * Account changes must invalidate the instance identity before restoring saved refs.
 */
export const make = Effect.fn("KiloSessionClient.make")(function* (input: {
  readonly instanceId: string;
  readonly directory: string;
  readonly baseUrl: string;
  readonly serverPassword?: string;
  readonly beforeRequest?: Effect.Effect<void, KiloSessionError>;
}) {
  const client = createKiloClient({
    baseUrl: input.baseUrl,
    directory: input.directory,
    throwOnError: true,
    // Mutation redirects must never forward an authorization header or repeat a prompt elsewhere.
    redirect: "error",
    ...(input.serverPassword === undefined
      ? {}
      : {
          headers: {
            Authorization: `Basic ${Buffer.from(`kilo:${input.serverPassword}`).toString("base64")}`,
          },
        }),
  });

  const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<{ data?: A }>) =>
    (input.beforeRequest ?? Effect.void).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: run,
          catch: (cause) => new KiloSessionError({ operation, reason: "request_failed", cause }),
        }),
      ),
      Effect.timeout("10 seconds"),
      Effect.catchTag(
        "TimeoutError",
        (cause) => new KiloSessionError({ operation, reason: "request_failed", cause }),
      ),
      Effect.flatMap((response) =>
        response.data === undefined
          ? Effect.fail(new KiloSessionError({ operation, reason: "invalid_response" }))
          : Effect.succeed(response.data),
      ),
      Effect.tap(() => input.beforeRequest ?? Effect.void),
    );

  const acknowledge = (operation: string) => (accepted: unknown) =>
    accepted === true
      ? Effect.void
      : Effect.fail(new KiloSessionError({ operation, reason: "invalid_response" }));

  const checkOwner = (ref: KiloSessionRef, operation: string) =>
    ref.instanceId !== input.instanceId || ref.directory !== input.directory
      ? Effect.fail(new KiloSessionError({ operation, reason: "wrong_owner" }))
      : Effect.void;

  // Kilo's GET /session/{id} can resolve an id from another directory. The SDK directory
  // header is routing context, not authorization. Check the returned owner before every mutation.
  const read = (ref: KiloSessionRef) =>
    checkOwner(ref, "session.get").pipe(
      Effect.andThen(
        request("session.get", (signal) =>
          client.session.get({ sessionID: ref.sessionId }, { signal }),
        ),
      ),
      Effect.flatMap((session) =>
        isSessionOwner(session) &&
        session.id === ref.sessionId &&
        session.directory === input.directory
          ? Effect.succeed(session)
          : Effect.fail(new KiloSessionError({ operation: "session.get", reason: "wrong_owner" })),
      ),
    );

  const owned = <A>(
    ref: KiloSessionRef,
    operation: string,
    run: (signal: AbortSignal) => Promise<{ data?: A }>,
  ) => read(ref).pipe(Effect.andThen(request(operation, run)));

  const ownedReference = (operation: string) => (session: unknown) =>
    isSessionOwner(session) && session.directory === input.directory
      ? Effect.succeed<KiloSessionRef>({
          instanceId: input.instanceId,
          directory: session.directory,
          sessionId: session.id,
        })
      : Effect.fail(new KiloSessionError({ operation, reason: "wrong_owner" }));

  const ownerCheck = (ref: KiloSessionRef, signal: AbortSignal) => {
    const owners = new Map<string, boolean>([[ref.sessionId, true]]);
    return async (sessionId: string): Promise<boolean> => {
      let id: string | undefined = sessionId;
      const visited = new Set<string>();
      while (id && !visited.has(id) && visited.size < 32) {
        const cached = owners.get(id);
        if (cached !== undefined) {
          owners.set(sessionId, cached);
          return cached;
        }
        visited.add(id);
        const session: Session | undefined = (
          await client.session.get(
            { sessionID: id },
            {
              signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            },
          )
        ).data;
        if (!isSessionOwner(session) || session.id !== id || session.directory !== input.directory)
          break;
        id = session.parentID;
      }
      owners.set(sessionId, false);
      return false;
    };
  };

  const health = yield* request("global.health", (signal) => client.global.health({ signal })).pipe(
    Effect.flatMap((value) =>
      decodeHealth(value).pipe(
        Effect.mapError(
          (cause) =>
            new KiloSessionError({
              operation: "global.health",
              reason: "unsupported_version",
              cause,
            }),
        ),
      ),
    ),
  );

  return {
    version: health.version,
    models: () => request("provider.list", (signal) => client.provider.list(undefined, { signal })),
    agents: () => request("app.agents", (signal) => client.app.agents(undefined, { signal })),
    create: (
      permission: NonNullable<Parameters<KiloClient["session"]["create"]>[0]>["permission"],
    ) =>
      request("session.create", (signal) =>
        client.session.create(permission === undefined ? {} : { permission }, { signal }),
      ).pipe(Effect.flatMap(ownedReference("session.create"))),
    read,
    history: (ref: KiloSessionRef) =>
      owned(ref, "session.messages", (signal) =>
        client.session.messages({ sessionID: ref.sessionId }, { signal }),
      ),
    fork: (ref: KiloSessionRef, messageID?: string) =>
      owned(ref, "session.fork", (signal) =>
        client.session.fork(
          { sessionID: ref.sessionId, ...(messageID === undefined ? {} : { messageID }) },
          { signal },
        ),
      ).pipe(Effect.flatMap(ownedReference("session.fork"))),
    prompt: (
      ref: KiloSessionRef,
      prompt: Omit<
        Parameters<KiloClient["session"]["promptAsync"]>[0],
        "sessionID" | "directory" | "workspace"
      >,
    ) =>
      read(ref).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: (signal) =>
              client.session.promptAsync(
                {
                  ...prompt,
                  sessionID: ref.sessionId,
                  directory: input.directory,
                },
                { signal, throwOnError: false },
              ),
            catch: (cause) =>
              new KiloSessionError({
                operation: "session.promptAsync",
                reason: "admission_unknown",
                cause,
              }),
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTag(
              "TimeoutError",
              (cause) =>
                new KiloSessionError({
                  operation: "session.promptAsync",
                  reason: "admission_unknown",
                  cause,
                }),
            ),
          ),
        ),
        Effect.flatMap((response) =>
          response.response?.status === 204
            ? Effect.void
            : Effect.fail(
                new KiloSessionError({
                  operation: "session.promptAsync",
                  reason:
                    response.response?.status &&
                    response.response.status >= 400 &&
                    response.response.status < 500
                      ? "request_failed"
                      : "admission_unknown",
                }),
              ),
        ),
      ),
    generate: (
      ref: KiloSessionRef,
      prompt: Omit<
        Parameters<KiloClient["session"]["prompt"]>[0],
        "sessionID" | "directory" | "workspace"
      >,
    ) =>
      read(ref).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: (signal) =>
              client.session.prompt({ ...prompt, sessionID: ref.sessionId }, { signal }),
            catch: () =>
              new KiloSessionError({ operation: "session.prompt", reason: "admission_unknown" }),
          }),
        ),
        Effect.timeout("2 minutes"),
        Effect.mapError(
          () => new KiloSessionError({ operation: "session.prompt", reason: "request_failed" }),
        ),
        Effect.flatMap((response) =>
          isGeneration(response.data) &&
          response.data &&
          !response.data.info.error &&
          response.data.parts.every((part) => part.type !== "text" || typeof part.text === "string")
            ? Effect.succeed(response.data)
            : Effect.fail(
                new KiloSessionError({ operation: "session.prompt", reason: "invalid_response" }),
              ),
        ),
      ),
    abort: (ref: KiloSessionRef) =>
      owned(ref, "session.abort", (signal) =>
        client.session.abort({ sessionID: ref.sessionId }, { signal }),
      ).pipe(Effect.flatMap(acknowledge("session.abort"))),
    replyPermission: (
      ref: KiloSessionRef,
      requestID: string,
      reply: "once" | "always" | "reject",
    ) =>
      owned(ref, "permission.list", (signal) => client.permission.list(undefined, { signal })).pipe(
        Effect.flatMap((pending) =>
          isPendingOwners(pending) &&
          pending.some((p) => p.id === requestID && p.sessionID === ref.sessionId)
            ? request("permission.reply", (signal) =>
                client.permission.reply({ requestID, reply }, { signal }),
              ).pipe(Effect.flatMap(acknowledge("permission.reply")))
            : Effect.fail(
                new KiloSessionError({ operation: "permission.reply", reason: "wrong_owner" }),
              ),
        ),
      ),
    replyQuestion: (ref: KiloSessionRef, requestID: string, answers: string[][]) =>
      owned(ref, "question.list", (signal) => client.question.list(undefined, { signal })).pipe(
        Effect.flatMap((pending) =>
          isPendingOwners(pending) &&
          pending.some((p) => p.id === requestID && p.sessionID === ref.sessionId)
            ? request("question.reply", (signal) =>
                client.question.reply({ requestID, answers }, { signal }),
              ).pipe(Effect.flatMap(acknowledge("question.reply")))
            : Effect.fail(
                new KiloSessionError({ operation: "question.reply", reason: "wrong_owner" }),
              ),
        ),
      ),
    pending: (ref: KiloSessionRef, includeChildren = false) =>
      owned(ref, "interaction.list", async (signal) => {
        const [permissions, questions] = await Promise.all([
          client.permission.list(undefined, { signal }),
          client.question.list(undefined, { signal }),
        ]);
        if (!isPendingOwners(permissions.data) || !isPendingOwners(questions.data))
          throw new KiloSessionError({ operation: "interaction.list", reason: "invalid_response" });
        const belongs = ownerCheck(ref, signal);
        const pending = [...permissions.data, ...questions.data];
        const decisions = await Promise.all(
          pending.map((entry) =>
            entry.sessionID === ref.sessionId
              ? true
              : includeChildren
                ? belongs(entry.sessionID)
                : false,
          ),
        );
        return { data: pending.filter((_, index) => decisions[index]) };
      }),
    status: (ref: KiloSessionRef) =>
      owned(ref, "session.status", (signal) => client.session.status(undefined, { signal })).pipe(
        Effect.filterOrFail(
          isStatusMap,
          () => new KiloSessionError({ operation: "session.status", reason: "invalid_response" }),
        ),
        Effect.map((statuses) => statuses[ref.sessionId]?.type ?? "idle"),
      ),
    setPermissions: (
      ref: KiloSessionRef,
      permission: NonNullable<Parameters<KiloClient["session"]["update"]>[0]>["permission"],
    ) =>
      owned(ref, "session.update", (signal) =>
        client.session.update(
          { sessionID: ref.sessionId, ...(permission === undefined ? {} : { permission }) },
          { signal },
        ),
      ),
    events: (
      ref: KiloSessionRef,
      onConnected: Effect.Effect<void, KiloSessionError> = Effect.void,
      includeChildren = false,
    ) =>
      Stream.unwrap(
        read(ref).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const controller = new AbortController();
              yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
              let streamFailure: unknown;
              const subscription = yield* Effect.tryPromise({
                try: () =>
                  client.event.subscribe(undefined, {
                    signal: controller.signal,
                    sseMaxRetryAttempts: 0,
                    onSseError: (cause) => {
                      streamFailure = cause;
                    },
                  }),
                catch: (cause) =>
                  new KiloSessionError({
                    operation: "event.subscribe",
                    reason: "request_failed",
                    cause,
                  }),
              });
              const interruptible: AsyncIterable<Event> = {
                [Symbol.asyncIterator]() {
                  const iterator = subscription.stream[Symbol.asyncIterator]();
                  const belongsToRoot = ownerCheck(ref, controller.signal);
                  return {
                    next: async () => {
                      // Filter before crossing the Effect stream boundary. No batching or additional
                      // queue: SDK backpressure and order are preserved, including readiness.
                      while (true) {
                        const timer = setTimeout(() => controller.abort(), 45_000);
                        let result: IteratorResult<Event>;
                        try {
                          result = await iterator.next();
                        } finally {
                          clearTimeout(timer);
                        }
                        if (result.done) return result;
                        if (
                          isEventEnvelope(result.value) &&
                          result.value.type === "server.connected"
                        )
                          return result;
                        const owner = sessionIdOf(result.value);
                        if (typeof owner === "object") throw owner;
                        if (
                          owner === ref.sessionId ||
                          (includeChildren &&
                            typeof owner === "string" &&
                            (await belongsToRoot(owner)))
                        )
                          return result;
                      }
                    },
                    return: async () => {
                      // Abort a pending reader.read before awaiting generator cleanup.
                      // A scope finalizer alone runs after fromAsyncIterable's finalizer.
                      controller.abort();
                      return iterator.return
                        ? iterator.return()
                        : { done: true as const, value: undefined };
                    },
                  };
                },
              };
              return Stream.fromAsyncIterable(interruptible, (cause) =>
                isKiloSessionError(cause)
                  ? cause
                  : new KiloSessionError({
                      operation: "event.subscribe",
                      reason: "request_failed",
                      cause,
                    }),
              ).pipe(
                Stream.mapError((cause) =>
                  isKiloSessionError(cause)
                    ? cause
                    : new KiloSessionError({
                        operation: "event.subscribe",
                        reason: "request_failed",
                        cause,
                      }),
                ),
                Stream.tap((event) =>
                  isEventEnvelope(event) && event.type === "server.connected"
                    ? onConnected
                    : Effect.void,
                ),
                Stream.filter((event) => event.type !== "server.connected"),
                Stream.concat(
                  Stream.unwrap(
                    Effect.sync(() =>
                      Stream.fail(
                        new KiloSessionError({
                          operation: "event.subscribe",
                          reason: "request_failed",
                          cause: streamFailure,
                        }),
                      ),
                    ),
                  ),
                ),
              );
            }),
          ),
        ),
      ),
  };
});
