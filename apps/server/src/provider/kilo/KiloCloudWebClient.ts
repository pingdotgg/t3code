import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Socket from "effect/unstable/socket/Socket";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { KiloCloudError } from "./KiloCloudClient.ts";

// Customer routes used by Kilo's web/mobile clients (Kilo-Org/cloud 78ea0a5e).
// workspace_* is the control-plane session; ses_* is its conversation; worktree_*
// owns the remote files. Numeric `version` fields are not protocol versions.
const CloudId = Schema.String.check(Schema.isPattern(/^workspace_[0-9a-f-]{36}$/i));
const WorktreeId = Schema.String.check(Schema.isPattern(/^worktree_[0-9a-f-]{36}$/i));
const NativeId = Schema.String.check(Schema.isPattern(/^ses_[0-9A-Za-z]+$/));
const MessageId = Schema.String.check(Schema.isPattern(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/));
export const CloudBinding = Schema.Struct({
  accountId: Schema.NonEmptyString,
  cloudAgentSessionId: CloudId,
  kiloSessionId: NativeId,
  worktreeId: WorktreeId,
  repository: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
});
export type CloudBinding = typeof CloudBinding.Type;
const Prepared = Schema.Struct({ cloudAgentSessionId: CloudId, kiloSessionId: NativeId });
const Sent = Schema.Struct({
  cloudAgentSessionId: CloudId,
  messageId: MessageId,
  status: Schema.Literal("started"),
  delivery: Schema.Literals(["sent", "queued"]),
});
const Session = Schema.Struct({
  sessionId: CloudId,
  kiloSessionId: NativeId,
  userId: Schema.NonEmptyString,
  orgId: Schema.optional(Schema.String),
  worktreeId: WorktreeId,
  githubRepo: Schema.NonEmptyString,
  upstreamBranch: Schema.optional(Schema.String),
  autoCommit: Schema.Boolean,
  initialMessageId: Schema.optional(MessageId),
  execution: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
});
const Result = Schema.NullOr(
  Schema.Struct({
    cloudAgentSessionId: CloudId,
    messageId: MessageId,
    status: Schema.Literals(["queued", "running", "completed", "failed", "interrupted"]),
  }),
);
const NativeMessage = Schema.Struct({
  info: Schema.Struct({
    id: Schema.NonEmptyString,
    sessionID: NativeId,
    role: Schema.Literals(["user", "assistant"]),
    parentID: Schema.optional(Schema.String),
    time: Schema.Struct({ created: Schema.Number, completed: Schema.optional(Schema.Number) }),
    cost: Schema.optional(Schema.Number),
    finish: Schema.optional(Schema.String),
  }),
  parts: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      sessionID: NativeId,
      messageID: Schema.NonEmptyString,
      type: Schema.String,
      text: Schema.optional(Schema.String),
      tool: Schema.optional(Schema.String),
      callID: Schema.optional(Schema.String),
      state: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
export type CloudMessage = typeof NativeMessage.Type;
const History = Schema.Struct({
  kiloSessionId: NativeId,
  history: Schema.NullOr(
    Schema.Struct({
      messages: Schema.Array(NativeMessage),
      nextCursor: Schema.NullOr(Schema.String),
      omittedItemCount: Schema.Number,
    }),
  ),
  watermarkEventId: Schema.NullOr(Schema.Number),
});
const Sandbox = Schema.Struct({
  status: Schema.Literals([
    "active",
    "sleeping",
    "starting",
    "stopping",
    "error",
    "unreachable",
    "unknown",
  ]),
  observedAt: Schema.Number,
  inactivityTimeoutMs: Schema.NullOr(Schema.Number),
  estimatedSleepAt: Schema.NullOr(Schema.Number),
});
const Billing = Schema.Struct({
  phase: Schema.Literals(["idle", "active", "stopping", "settling", "unavailable"]),
  attribution: Schema.Literals(["payer_shared", "session"]),
  estimatedHourlyRateMicrodollars: Schema.NullOr(Schema.Number),
  estimatedIntervalAmountMicrodollars: Schema.NullOr(Schema.Number),
});
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Profiles = Schema.Array(
  Schema.Struct({
    id: Schema.NonEmptyString,
    isDefault: Schema.Boolean,
    varCount: Count,
    commandCount: Count,
    mcpServerCount: Count,
    skillCount: Count,
    agentCount: Count,
    kiloCommandCount: Count,
  }),
);
const Bindings = Schema.Array(
  Schema.Struct({
    repoFullName: Schema.NonEmptyString,
    platform: Schema.String,
    profileId: Schema.NonEmptyString,
  }),
);
const Permission = Schema.Struct({
  id: Schema.NonEmptyString,
  sessionID: NativeId,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
});
const Question = Schema.Struct({
  id: Schema.NonEmptyString,
  sessionID: NativeId,
  questions: Schema.Array(
    Schema.Struct({
      header: Schema.String,
      question: Schema.String,
      options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
      multiple: Schema.optional(Schema.Boolean),
      custom: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type CloudInteraction = typeof Permission.Type | typeof Question.Type;
const Pending = Schema.Struct({
  questions: Schema.Array(Question),
  permissions: Schema.Array(Permission),
});
const Acknowledged = Schema.Struct({ success: Schema.Boolean });
const envelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ result: Schema.Struct({ data: Schema.Unknown }) })),
);
const Ticket = Schema.Struct({ ticket: Schema.NonEmptyString, expiresAt: Schema.Number });
const StreamEvent = Schema.Struct({
  eventId: Schema.Number,
  sessionId: CloudId,
  streamEventType: Schema.NonEmptyString,
  data: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeStreamEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(StreamEvent));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isCloudError = Schema.is(KiloCloudError);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const make = (options: {
  readonly token: Redacted.Redacted<string>;
  /** Immutable authenticated personal account id, never a display name or token hash. */
  readonly accountId: string;
  readonly origin?: string;
  readonly credentials?: Effect.Effect<
    { readonly token: Redacted.Redacted<string>; readonly accountId: string },
    KiloCloudError
  >;
}) => {
  const origin = options.origin ?? "https://app.kilo.ai";
  const allowed = origin === "https://app.kilo.ai" || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
  const failure = (operation: string, reason: KiloCloudError["reason"], messageId?: string) =>
    new KiloCloudError({ operation, reason, ...(messageId ? { messageId } : {}) });
  const request = <A>(
    operation: string,
    body: unknown,
    schema: Schema.Decoder<A>,
    mutation = false,
    messageId?: string,
    beforePaidPost: Effect.Effect<void, KiloCloudError> = Effect.void,
  ) => {
    const uncertain = () =>
      failure(operation, mutation ? "admission_unknown" : "invalid_response", messageId);
    if (!allowed) return Effect.fail(failure(operation, "rejected"));
    return Effect.gen(function* () {
      const credentials = options.credentials ? yield* options.credentials : options;
      if (credentials.accountId !== options.accountId)
        return yield* failure(operation, "wrong_owner");
      const client = yield* HttpClient.HttpClient;
      const req = HttpClientRequest.make(mutation ? "POST" : "GET")(
        operation === "stream-ticket"
          ? `${origin}/api/cloud-agent-next/sessions/stream-ticket`
          : `${origin}/api/trpc/${operation}${mutation ? "" : `?input=${encodeURIComponent(encode(body))}`}`,
        {
          headers: {
            authorization: `Bearer ${Redacted.value(credentials.token)}`,
            "content-type": "application/json",
          },
        },
      );
      const preparedRequest = mutation
        ? HttpClientRequest.bodyText(req, encode(body), "application/json")
        : req;
      // Commit the durable attempt boundary after all local/preflight work. A failed
      // commit must prevent execute; after this point an outcome may be uncertain.
      yield* beforePaidPost;
      const response = yield* client.execute(preparedRequest);
      if (response.status < 200 || response.status >= 300)
        return yield* response.status >= 500 || response.status === 408 || response.status === 409
          ? uncertain()
          : failure(
              operation,
              !mutation && response.status === 404 ? "not_found" : "rejected",
              messageId,
            );
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* response.stream.pipe(
        Stream.runForEach((chunk) => {
          size += chunk.byteLength;
          if (size > 8 * 1024 * 1024) return Effect.fail(uncertain());
          chunks.push(chunk);
          return Effect.void;
        }),
      );
      const text = Buffer.concat(chunks).toString("utf8");
      const data =
        operation === "stream-ticket"
          ? yield* decodeJson(text)
          : (yield* envelope(text)).result.data;
      return yield* Schema.decodeUnknownEffect(schema)(data);
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout("30 seconds"),
      Effect.mapError((error) => (isCloudError(error) ? error : uncertain())),
    );
  };
  const own = (binding: CloudBinding) =>
    binding.accountId === options.accountId
      ? Effect.void
      : Effect.fail(failure("ownership", "wrong_owner"));
  const getSession = (id: string) =>
    request("cloudAgentNext.getSession", { cloudAgentSessionId: id }, Session).pipe(
      Effect.flatMap((session) =>
        session.sessionId === id &&
        session.userId === options.accountId &&
        session.orgId === undefined
          ? Effect.succeed(session)
          : Effect.fail(failure("getSession", "wrong_owner")),
      ),
    );
  const check = (binding: CloudBinding) =>
    own(binding).pipe(
      Effect.andThen(getSession(binding.cloudAgentSessionId)),
      Effect.flatMap((session) =>
        session.kiloSessionId === binding.kiloSessionId &&
        session.worktreeId === binding.worktreeId &&
        session.githubRepo === binding.repository &&
        session.upstreamBranch === binding.branch &&
        !session.autoCommit
          ? Effect.succeed(session)
          : Effect.fail(failure("ownership", "wrong_owner")),
      ),
    );
  // The web API merges the default and repository profiles additively. Empty
  // overrides do not disable them. Read only summaries, never profile secrets.
  const preflight = (repository: string) =>
    Effect.gen(function* () {
      const profiles = yield* request("agentProfiles.list", {}, Profiles);
      const bindings = yield* request("agentProfiles.listRepoBindings", {}, Bindings);
      const defaults = profiles.filter((profile) => profile.isDefault);
      const relevant = bindings.filter(
        (binding) =>
          binding.platform === "github" &&
          binding.repoFullName.toLowerCase() === repository.toLowerCase(),
      );
      if (
        defaults.length > 1 ||
        relevant.length > 1 ||
        new Set(profiles.map((profile) => profile.id)).size !== profiles.length
      )
        return yield* failure("profile-preflight", "rejected");
      const ids = new Set([
        ...defaults.map((profile) => profile.id),
        ...relevant.map((binding) => binding.profileId),
      ]);
      for (const id of ids) {
        const profile = profiles.find((profile) => profile.id === id);
        if (
          !profile ||
          [
            profile.varCount,
            profile.commandCount,
            profile.mcpServerCount,
            profile.skillCount,
            profile.agentCount,
            profile.kiloCommandCount,
          ].some((count) => count !== 0)
        )
          return yield* failure("profile-preflight", "rejected");
      }
    });
  // Keep progress across the adapter's bounded reconcile calls. A timed-out GET
  // retries only that read, never the paid admission or the whole first page.
  const admissionScans = new Map<
    string,
    {
      cursor?: string | undefined;
      pending: Array<{ session_id: string; cloud_agent_session_id: string | null }>;
      deferred: Array<{ session_id: string; cloud_agent_session_id: string | null }>;
      loaded: boolean;
      rounds: number;
      failures: number;
      touchedAt: number;
      seenCursors: Set<string>;
      matches: Map<string, typeof Prepared.Type>;
    }
  >();
  return {
    getSession,
    /** Short-lived customer tickets only. A closed socket has no stop semantics. */
    events: (binding: CloudBinding, fromId = 0) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* own(binding);
          const ticket = yield* request(
            "stream-ticket",
            { cloudAgentSessionId: binding.cloudAgentSessionId },
            Ticket,
            true,
          );
          const socketOrigin =
            origin === "https://app.kilo.ai"
              ? "wss://cloud-agent-next.kilosessions.ai"
              : origin.replace("http:", "ws:");
          const url = new URL(`${socketOrigin}/stream`);
          url.searchParams.set("cloudAgentSessionId", binding.cloudAgentSessionId);
          url.searchParams.set("ticket", ticket.ticket);
          url.searchParams.set("fromId", String(fromId));
          const socket = yield* Socket.makeWebSocket(url.toString(), {
            openTimeout: "10 seconds",
          }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
          return Stream.fromPull(Socket.readerString(socket)).pipe(
            Stream.mapEffect((text) =>
              Effect.gen(function* () {
                if (text.length > 8 * 1024 * 1024)
                  return yield* failure("events", "invalid_response");
                const credentials = options.credentials ? yield* options.credentials : options;
                if (credentials.accountId !== binding.accountId)
                  return yield* failure("events", "wrong_owner");
                const event = yield* decodeStreamEvent(text);
                if (event.sessionId !== binding.cloudAgentSessionId)
                  return yield* failure("events", "wrong_owner");
                return event;
              }),
            ),
          );
        }),
      ).pipe(
        Stream.scoped,
        Stream.mapError((cause) =>
          isCloudError(cause) ? cause : failure("events", "invalid_response"),
        ),
      ),
    // Recovery only: enumerate access-checked metadata and correlate the persisted
    // initial message, never replay a paid prepare after a lost response.
    findAdmission: (repository: string, initialMessageId: string) =>
      Effect.gen(function* () {
        const key = `${repository}\0${initialMessageId}`;
        const now = yield* Clock.currentTimeMillis;
        for (const [cachedKey, cached] of admissionScans)
          if (now - cached.touchedAt > 300_000) admissionScans.delete(cachedKey);
        let scan = admissionScans.get(key);
        if (!scan) {
          if (admissionScans.size >= 64) admissionScans.delete(admissionScans.keys().next().value!);
          scan = {
            rounds: 0,
            failures: 0,
            touchedAt: now,
            pending: [],
            deferred: [],
            loaded: false,
            seenCursors: new Set(),
            matches: new Map(),
          };
          admissionScans.set(key, scan);
        }
        scan.touchedAt = now;
        // At most 25 candidate reads per call. Later polls continue this scan.
        for (let budget = 25; budget > 0; budget--) {
          if (!scan.pending.length) {
            if (scan.loaded && !scan.cursor) {
              if (scan.deferred.length) {
                if (++scan.rounds >= 3)
                  return yield* failure("reconcile-admission", "recovery_incomplete");
                scan.pending = scan.deferred;
                scan.deferred = [];
                return null;
              }
              admissionScans.delete(key);
              if (scan.matches.size > 1)
                return yield* failure("reconcile-admission", "wrong_owner");
              return [...scan.matches.values()][0] ?? null;
            }
            const page = yield* request(
              "cliSessionsV2.list",
              {
                gitUrl: `https://github.com/${repository}`,
                limit: 100,
                orderBy: "created_at",
                organizationId: null,
                ...(scan.cursor ? { cursor: scan.cursor } : {}),
              },
              Schema.Struct({
                cliSessions: Schema.Array(
                  Schema.Struct({
                    session_id: NativeId,
                    cloud_agent_session_id: Schema.NullOr(Schema.String),
                  }),
                ),
                nextCursor: Schema.NullOr(Schema.String),
              }),
            );
            if (
              page.nextCursor &&
              (scan.seenCursors.has(page.nextCursor) || scan.seenCursors.size >= 100)
            )
              return yield* failure("reconcile-admission", "recovery_incomplete");
            if (page.nextCursor) scan.seenCursors.add(page.nextCursor);
            scan.cursor = page.nextCursor ?? undefined;
            scan.loaded = true;
            scan.pending = page.cliSessions.filter((candidate) =>
              candidate.cloud_agent_session_id?.startsWith("workspace_"),
            );
            if (!scan.pending.length) continue;
          }
          const candidate = scan.pending.shift()!;
          const deferred = scan.deferred;
          const session = yield* getSession(candidate.cloud_agent_session_id!).pipe(
            Effect.catchTag("KiloCloudError", (error) => {
              if (error.reason === "not_found") return Effect.succeed(null);
              if (error.reason === "invalid_response")
                return Effect.sync(() => {
                  deferred.push(candidate);
                  return null;
                });
              return Effect.fail(error);
            }),
            // Preserve and rotate an interrupted/unavailable read. A stale first
            // candidate must not starve all subsequent candidates on every poll.
            Effect.onError(() =>
              Effect.sync(() => {
                deferred.push(candidate);
              }),
            ),
          );
          if (!session) continue;
          if (
            session.initialMessageId === initialMessageId &&
            session.githubRepo === repository &&
            session.kiloSessionId === candidate.session_id
          )
            scan.matches.set(session.sessionId, {
              cloudAgentSessionId: session.sessionId,
              kiloSessionId: session.kiloSessionId,
            });
        }
        return null;
      }).pipe(
        Effect.catchTag("KiloCloudError", (cause) =>
          Effect.gen(function* () {
            const key = `${repository}\0${initialMessageId}`;
            const scan = admissionScans.get(key);
            if (scan && ++scan.failures >= 3) {
              admissionScans.delete(key);
              return yield* failure("reconcile-admission", "recovery_incomplete");
            }
            if (cause.reason === "recovery_incomplete" || cause.reason === "wrong_owner")
              admissionScans.delete(key);
            return yield* cause;
          }),
        ),
      ),
    forgetAdmission: (repository: string, initialMessageId: string) =>
      Effect.sync(() => {
        admissionScans.delete(`${repository}\0${initialMessageId}`);
      }),
    /** Admission is paid. Persist operationKey and initialMessageId before calling; no retries here. */
    prepare: (
      input: {
        readonly operationKey: string;
        readonly initialMessageId: string;
        readonly prompt: string;
        readonly repository: string;
        readonly branch: string;
        readonly model: string;
        readonly variant?: string;
      },
      beforePaidPost: Effect.Effect<void, KiloCloudError> = Effect.void,
    ) =>
      preflight(input.repository).pipe(
        Effect.andThen(
          request(
            "cloudAgentNext.prepareSession",
            {
              operationKey: input.operationKey,
              initialMessageId: input.initialMessageId,
              prompt: input.prompt,
              githubRepo: input.repository,
              upstreamBranch: input.branch,
              model: input.model,
              ...(input.variant ? { variant: input.variant } : {}),
              mode: "code",
              autoInitiate: true,
              autoCommit: false,
              devcontainer: false,
              // These are additive overrides. A separate profile preflight must reject inherited configuration before admission.
              envVars: {},
              setupCommands: [],
              mcpServers: {},
              runtimeSkills: [],
              runtimeAgents: [],
            },
            Prepared,
            true,
            input.initialMessageId,
            beforePaidPost,
          ),
        ),
      ),
    bind: (
      prepared: typeof Prepared.Type,
      repository: string,
      initialMessageId: string,
      branch: string,
    ) =>
      getSession(prepared.cloudAgentSessionId).pipe(
        Effect.flatMap((session) =>
          session.kiloSessionId === prepared.kiloSessionId &&
          session.githubRepo === repository &&
          session.upstreamBranch === branch &&
          session.initialMessageId === initialMessageId &&
          !session.autoCommit
            ? Effect.succeed({
                accountId: options.accountId,
                cloudAgentSessionId: session.sessionId,
                kiloSessionId: session.kiloSessionId,
                worktreeId: session.worktreeId,
                repository,
                branch,
              })
            : Effect.fail(failure("bind", "wrong_owner")),
        ),
      ),
    send: (
      binding: CloudBinding,
      input: {
        readonly messageId: string;
        readonly prompt: string;
        readonly model: string;
        readonly variant?: string;
      },
      beforePaidPost: Effect.Effect<void, KiloCloudError> = Effect.void,
    ) =>
      check(binding).pipe(
        Effect.andThen(
          request(
            "cloudAgentNext.sendMessage",
            {
              cloudAgentSessionId: binding.cloudAgentSessionId,
              expectedWorktreeId: binding.worktreeId,
              messageId: input.messageId,
              autoCommit: false,
              payload: {
                type: "prompt",
                prompt: input.prompt,
                mode: "code",
                model: input.model,
                ...(input.variant ? { variant: input.variant } : {}),
              },
            },
            Sent,
            true,
            input.messageId,
            beforePaidPost,
          ),
        ),
        Effect.flatMap((sent) =>
          sent.cloudAgentSessionId === binding.cloudAgentSessionId &&
          sent.messageId === input.messageId
            ? Effect.asVoid(Effect.succeed(sent))
            : Effect.fail(failure("send", "admission_unknown", input.messageId)),
        ),
      ),
    result: (binding: CloudBinding, messageId: string) =>
      own(binding).pipe(
        Effect.andThen(
          request(
            "cloudAgentNext.getMessageResult",
            {
              cloudAgentSessionId: binding.cloudAgentSessionId,
              expectedWorktreeId: binding.worktreeId,
              messageId,
            },
            Result,
          ),
        ),
        Effect.flatMap((result) =>
          result === null ||
          (result.cloudAgentSessionId === binding.cloudAgentSessionId &&
            result.messageId === messageId)
            ? Effect.succeed(result)
            : Effect.fail(failure("result", "wrong_owner")),
        ),
      ),
    history: (binding: CloudBinding, cursor?: string) =>
      own(binding).pipe(
        Effect.andThen(
          request(
            "cliSessionsV2.getSessionMessagesPage",
            { session_id: binding.kiloSessionId, limit: 50, ...(cursor ? { cursor } : {}) },
            History,
          ),
        ),
        Effect.flatMap((page) =>
          page.kiloSessionId === binding.kiloSessionId &&
          (page.history === null ||
            page.history.messages.every(
              (message) =>
                message.info.sessionID === binding.kiloSessionId &&
                message.parts.every(
                  (part) =>
                    part.sessionID === binding.kiloSessionId && part.messageID === message.info.id,
                ),
            ))
            ? Effect.succeed(page)
            : Effect.fail(failure("history", "wrong_owner")),
        ),
      ),
    pending: (binding: CloudBinding) =>
      check(binding).pipe(
        Effect.andThen(
          request(
            "cloudAgentNext.getPendingInteractions",
            { cloudAgentSessionId: binding.cloudAgentSessionId },
            Pending,
          ),
        ),
        Effect.filterOrFail(
          (pending) =>
            [...pending.questions, ...pending.permissions].every(
              (request) => request.sessionID === binding.kiloSessionId,
            ),
          () => failure("pending", "wrong_owner"),
        ),
      ),
    interrupt: (binding: CloudBinding) =>
      check(binding).pipe(
        Effect.andThen(
          request(
            "cloudAgentNext.interruptSession",
            { sessionId: binding.cloudAgentSessionId },
            Schema.Struct({ success: Schema.Boolean }),
            true,
          ),
        ),
      ),
    replyPermission: (
      binding: CloudBinding,
      permissionId: string,
      response: "once" | "always" | "reject",
    ) =>
      check(binding).pipe(
        Effect.andThen(
          request(
            "cloudAgentNext.answerPermission",
            { sessionId: binding.cloudAgentSessionId, permissionId, response },
            Acknowledged,
            true,
          ),
        ),
      ),
    replyQuestion: (
      binding: CloudBinding,
      questionId: string,
      answers: ReadonlyArray<ReadonlyArray<string>>,
    ) =>
      check(binding).pipe(
        Effect.andThen(
          request(
            "cloudAgentNext.answerQuestion",
            { sessionId: binding.cloudAgentSessionId, questionId, answers },
            Acknowledged,
            true,
          ),
        ),
      ),
    sandbox: (binding: CloudBinding) =>
      own(binding).pipe(
        Effect.andThen(
          request(
            "cloudAgentNext.getSandboxStatus",
            { cloudAgentSessionId: binding.cloudAgentSessionId },
            Sandbox,
          ),
        ),
      ),
    billing: (binding: CloudBinding) =>
      own(binding).pipe(
        Effect.andThen(
          request(
            "cloudAgentNext.getComputeBillingStatus",
            { cloudAgentSessionId: binding.cloudAgentSessionId },
            Billing,
          ),
        ),
      ),
  };
};
