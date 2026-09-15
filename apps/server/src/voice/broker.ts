/**
 * VoiceLiveBroker - environment-owned GPT Live session brokering.
 *
 * The browser POSTs its WebRTC SDP offer; the broker exchanges it for a Live
 * session using the environment's OpenAI key held in ServerSecretStore, and
 * retains the returned Live session id for close accounting and usage. The
 * retained sessions live in memory for the server process lifetime; usage
 * survives close. No client secret or ephemeral key is ever issued to the
 * browser, and the broker never touches `/v1/realtime/calls`.
 *
 * Live session config (speech model, delegation backend model, instructions,
 * advertised tools) is broker configuration: defaults live here, overrides in
 * the `voice-broker-config` secret (JSON), and the OpenAI key in the
 * `openai-api-key` secret. The key is read per mint and never logged.
 */
import {
  AuthOrchestrationOperateScope,
  AuthAccessWriteScope,
  VoiceSettings,
  VoiceSettingsUpdate,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
  TrimmedNonEmptyString,
  VoiceBrokerSessionCloseInput,
  VoiceBrokerSessionCloseResult,
  VoiceBrokerSessionCreated,
  VoiceBrokerSessionRequest,
  VoiceBrokerSessionConfig,
  VoiceSessionId,
  VoiceSessionUsage,
  VoiceToolErrorCode,
  VoiceToolSchemas,
  VoiceBackendRequest,
  VoiceBackendResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const VOICE_BROKER_SESSIONS_PATH = "/api/voice/sessions";
export const VOICE_BROKER_CLOSE_PATH = "/api/voice/sessions/close";
export const VOICE_BROKER_USAGE_PATH = "/api/voice/sessions/usage";
export const VOICE_BACKEND_PATH = "/api/voice/backend";

/** ServerSecretStore entry holding the environment-owned OpenAI API key. */
export const OPENAI_API_KEY_SECRET_NAME = "openai-api-key";
/** ServerSecretStore entry holding optional broker config overrides (JSON):
    `{ liveModel?, backendModel?, instructions?, delegationInstructions? }`. */
export const VOICE_BROKER_CONFIG_SECRET_NAME = "voice-broker-config";

const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const encodeBackendInput = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
const decodeBackendResult = Schema.decodeUnknownEffect(VoiceBackendResult);

/** Documented Live speech model. Override via `voice-broker-config`. */
const DEFAULT_LIVE_MODEL = "gpt-live-1";
/** Small backend model for the managed Responses delegation. Override via
    `voice-broker-config`; T8 owns shipping a measured default. */
const DEFAULT_DELEGATION_MODEL = "gpt-5.6-terra";

const ACTION_FEEDBACK_POLICY =
  "For navigation and simple UI commands, remain silent before and after success. The app plays a chime after verified completion. Do not read out the thread title. Speak errors and necessary clarification.";
const EXISTING_THREAD_POLICY =
  "For an update about an existing thread use readThread/observeThread. To ask its worker for an update or further work use continueThread with the existing environmentId and threadId. Never replace a missing or ambiguous existing target with startThread. Only create a new thread when explicitly requested.";

export const DEFAULT_LIVE_INSTRUCTIONS =
  "You are Oracle, a concise voice assistant inside T3 Code.\n" +
  "Backchannel policy: For navigation and simple UI commands, stay silent while acting and after success. The app plays a completion chime. For other tasks, acknowledge briefly without guessing results.\n" +
  "Interruption policy: Stop speaking when interrupted and listen.\n" +
  "Delegation policy:\nBackend tools:\n" +
  "- T3: discover connected environments, projects and available models; search " +
  "and read authorized threads; open a thread in this window; start and observe work.\n" +
  "Delegate to the backend when:\n" +
  "- Delegate all requests about T3 projects or threads to the backend before " +
  "answering, including approximate topic searches and requests to show a thread.\n" +
  "- A correction changes the requested work.\n" +
  "Do not delegate to the backend when:\n" +
  "- The user greets you, asks to repeat a verified result, or needs a brief clarification.\n" +
  "Do not claim you lack access before the backend checks the connected environments. " +
  "Report permission or connection failures honestly when returned. Never claim an " +
  "action succeeded until the backend confirms it. While waiting, use only a neutral " +
  "acknowledgment, not a guessed destination. For an open-thread request, do not speak a confirmation or read out its title. The UI and completion chime acknowledge success. Speak only if clarification or an error requires attention. Do not volunteer thread " +
  "contents, plans, dates, or durations. Summarize content only when explicitly " +
  "requested and supplied by a backend read; a title is not evidence of contents.";

/** Delegation instructions sent with every minted session. The session-status
    semantics are the contract with the backend model: an in-band error must
    never be announced as success. Pinned by broker.test.ts. */
export const DEFAULT_DELEGATION_INSTRUCTIONS =
  "You select and call the provided voice tools to act on the user's T3 " +
  "workspaces. Prefer the narrowest tool that answers the request. Tool " +
  "results are returned by the client; never invent tool output. When a " +
  "request is ambiguous, ask one short clarifying question.\n" +
  "To operate the attached interface itself, list its controls with " +
  "listControls and activate one with clickControl. A clickControl result " +
  'is success only when its state is "activated"; disabled, hidden, stale ' +
  "and ambiguous targets must be reported as such, never as success. " +
  "Reuse a recent listing before listing again; re-list when a target is " +
  "stale. Opening a menu or dialog first may be required before its items " +
  "are listed.\n" +
  "An update about an existing thread uses readThread/observeThread. Asking that thread's worker for an update or further work uses continueThread with its existing environmentId and threadId. Resolve references from current UI context and search/read tools; ask if ambiguous. Never use startThread as a substitute for continuing or reading an existing thread, even if it cannot be found. startThread requires an explicit request to create a new thread. Successful navigation needs no verbal confirmation; the application plays a chime.\n" +
  "The session status rules below apply to continueThread as well as startThread.\n" +
  "Session status semantics for voice.startThread: the thread started only " +
  'when the returned session.status is "starting", "running", or ' +
  '"ready"; started means running, not finished. A session.status of ' +
  '"error" means the worker failed to start: say so and speak the ' +
  'session.lastError text to the user. A session.status of "interrupted" ' +
  'or "stopped" means a worker was on the thread but is not running now; ' +
  "report that status verbatim, and announce neither success nor failure " +
  "beyond what the status states. A missing session, or a session.status " +
  'of "idle", means the start could not be confirmed: no worker was ' +
  "observed running on the thread at read-back. Say the result could not " +
  "be confirmed yet, and check with voice.observeThread before stating an " +
  "outcome; do not announce success and do not announce definite failure " +
  "in any of those cases. Results that list several environments (a " +
  "perEnvironment array) succeed or fail per environment: an entry whose " +
  'environment.status is "ok" is valid evidence and must be used; an ' +
  'entry with status "partial" is valid but incomplete evidence, so use ' +
  "its results and say that some results from that environment are " +
  'missing; an entry with status "error" or "disconnected" failed, so ' +
  "name that environment and speak its error. The whole result is a " +
  'failure only when no environment has status "ok" or "partial". Any ' +
  'other tool result that contains an "error" field, including a ' +
  "single-environment result whose environment.error is present, is a " +
  "failure and must be reported to the user as a failure, never reframed " +
  "as success.";

// ---------------------------------------------------------------------------
// Broker errors (frozen VoiceToolError codes over HTTP)
// ---------------------------------------------------------------------------

export class VoiceBrokerError extends Schema.TaggedError<VoiceBrokerError>()("VoiceBrokerError", {
  code: VoiceToolErrorCode,
  message: Schema.String,
  /** HTTP status the route responds with. */
  status: Schema.Number,
}) {}

const voiceBrokerErrorResponse = (error: VoiceBrokerError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { code: error.code, message: error.message },
      {
        status: error.status,
      },
    ),
  );

const brokerInvalidRequest = (message: string, status = 400) =>
  new VoiceBrokerError({ code: "invalid_request", message, status });

// ---------------------------------------------------------------------------
// Voice tool advertisement (names from the frozen registry; concise because
// execution stays client-owned and the model-visible list grants no authority)
// ---------------------------------------------------------------------------

const voiceToolName = (tool: keyof typeof VoiceToolSchemas) => `voice.${String(tool)}`;

const VOICE_TOOL_DESCRIPTIONS: Record<keyof typeof VoiceToolSchemas, string> = {
  discoverEnvironments: "List connected T3 environments with connectivity and granted scopes.",
  discoverProjects: "List projects in one environment.",
  listModels: "List available models per provider in one environment.",
  searchThreads: "Search thread titles and messages across connected environments.",
  readThread: "Read a bounded excerpt of one thread's conversation.",
  readProject: "Summarize a project and list its recent threads.",
  openThread: "Open a thread in the user's attached T3 window and acknowledge it.",
  startThread: "Create and start a new T3 thread with an explicit model.",
  continueThread:
    "Send a follow-up or request an update from the worker in an EXISTING thread. Preserves its history, model, project and workspace. Never creates a thread.",
  observeThread: "Observe progress and completion of work running in a thread.",
  listControls:
    "List the attached T3 window's activatable interface controls (buttons, links, menu items, tabs, form controls) with stable ids, including disabled and optionally hidden ones.",
  clickControl:
    "Activate one listed interface control by its id in the attached T3 window. Success only when the result state is activated; disabled, hidden, stale and ambiguous targets are reported explicitly.",
};

export const voiceBrokerToolDefinitions = () =>
  (Object.keys(VoiceToolSchemas) as ReadonlyArray<keyof typeof VoiceToolSchemas>).map((tool) => ({
    name: voiceToolName(tool),
    description: VOICE_TOOL_DESCRIPTIONS[tool],
  }));

// ---------------------------------------------------------------------------
// Broker config
// ---------------------------------------------------------------------------

const VoiceBrokerConfigOverrides = Schema.Struct({
  liveModel: Schema.optional(TrimmedNonEmptyString),
  backendModel: Schema.optional(TrimmedNonEmptyString),
  instructions: Schema.optional(Schema.String),
  delegationInstructions: Schema.optional(Schema.String),
});

const encodeBrokerConfig = Schema.encodeEffect(Schema.fromJsonString(VoiceBrokerConfigOverrides));

export interface VoiceBrokerRuntimeConfig extends VoiceBrokerSessionConfig {}

const loadBrokerConfig = (secrets: ServerSecretStore["Service"]) =>
  Effect.gen(function* () {
    const overridesJson = yield* secrets
      .get(VOICE_BROKER_CONFIG_SECRET_NAME)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to read voice broker config secret", { cause }).pipe(
            Effect.as(Option.none<Uint8Array>()),
          ),
        ),
      );
    let overrides: typeof VoiceBrokerConfigOverrides.Type = {};
    if (Option.isSome(overridesJson)) {
      const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(VoiceBrokerConfigOverrides))(
        new TextDecoder().decode(overridesJson.value),
      );
      if (decoded._tag === "Success") {
        overrides = decoded.value;
      } else {
        yield* Effect.logWarning("ignoring malformed voice broker config secret");
      }
    }
    return {
      model: overrides.liveModel ?? DEFAULT_LIVE_MODEL,
      instructions: overrides.instructions,
      delegation: {
        type: "responses" as const,
        model: overrides.backendModel ?? DEFAULT_DELEGATION_MODEL,
        ...(overrides.delegationInstructions === undefined
          ? {}
          : { instructions: overrides.delegationInstructions }),
      },
      tools: voiceBrokerToolDefinitions().map((tool) => ({ ...tool })),
    } satisfies VoiceBrokerRuntimeConfig;
  });

// ---------------------------------------------------------------------------
// Upstream OpenAI exchange
// ---------------------------------------------------------------------------

/** Decode of the documented `POST /v1/live/sessions` success response
    (voice-webrtc guide, "Read the session response"): HTTP 201 with
    `{ session: { id }, transport: { type: "webrtc", sdp } }`. The session id
    and answer SDP are required — a response missing either is rejected with a
    frozen code, never substituted with a locally invented session id. (The
    exact live payload remains unverified against the real API per the T1
    `live_access_unavailable` gate; this is the documented shape, not an
    observed one.) */
const UpstreamLiveSessionCreated = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
  transport: Schema.Struct({
    type: Schema.optional(Schema.String),
    sdp: Schema.String,
  }),
});

const UpstreamErrorBody = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      code: Schema.optional(Schema.String),
    }),
  ),
});

/** Maps an OpenAI failure to the frozen VoiceToolError codes: credential
    problems are `auth_invalid`, upstream 5xx/network problems are
    `environment_unreachable`, and rejected requests are `invalid_request`. */
const upstreamFailureError = (status: number, detail: string): VoiceBrokerError => {
  const code: VoiceToolErrorCode =
    status === 401 || status === 403
      ? "auth_invalid"
      : status >= 500
        ? "environment_unreachable"
        : "invalid_request";
  const httpStatus = code === "auth_invalid" ? 401 : code === "environment_unreachable" ? 502 : 400;
  // Upstream messages are echoed without credentials or request bodies.
  return new VoiceBrokerError({
    code,
    message: `OpenAI Live session request failed: ${detail}`,
    status: httpStatus,
  });
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface RetainedVoiceSession {
  readonly status: "open" | "closed";
  readonly clientDelegation?: boolean;
  readonly lastUsage?: VoiceSessionUsage;
}

export class VoiceLiveBroker extends Context.Service<
  VoiceLiveBroker,
  {
    readonly getSettings: () => Effect.Effect<VoiceSettings, VoiceBrokerError>;
    readonly updateSettings: (
      input: VoiceSettingsUpdate,
    ) => Effect.Effect<VoiceSettings, VoiceBrokerError>;
    readonly respond: (
      input: VoiceBackendRequest,
    ) => Effect.Effect<VoiceBackendResult, VoiceBrokerError>;
    /** Exchanges the browser's SDP offer for a Live session via the
        environment-owned key and retains the returned session id. */
    readonly mintSession: (
      input: VoiceBrokerSessionRequest,
    ) => Effect.Effect<VoiceBrokerSessionCreated, VoiceBrokerError>;
    /** Marks a retained session closed. Closing an already-closed session is
        idempotent (`closed: true`); an unknown session is invalid_request. */
    readonly closeSession: (
      input: VoiceBrokerSessionCloseInput,
    ) => Effect.Effect<VoiceBrokerSessionCloseResult, VoiceBrokerError>;
    /** Stores a usage report for a retained session (client-relayed Live
        usage payloads: `session.usage.updated` and final `session.closed`). */
    readonly recordSessionUsage: (
      usage: VoiceSessionUsage,
    ) => Effect.Effect<VoiceSessionUsage, VoiceBrokerError>;
    /** Reads the last usage recorded for a retained session. */
    readonly getSessionUsage: (
      input: VoiceBrokerSessionCloseInput,
    ) => Effect.Effect<VoiceSessionUsage, VoiceBrokerError>;
  }
>()("t3/voice/broker/VoiceLiveBroker") {}

const makeBroker = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore;
  const sessions = yield* Ref.make(new Map<string, RetainedVoiceSession>());

  const settingsFailure = () => brokerInvalidRequest("Could not access voice settings.", 500);
  const getSettings = Effect.fn("VoiceLiveBroker.getSettings")(function* () {
    const config = yield* loadBrokerConfig(secrets);
    const key = yield* secrets
      .get(OPENAI_API_KEY_SECRET_NAME)
      .pipe(Effect.mapError(settingsFailure));
    return {
      keyConfigured: Option.isSome(key) && new TextDecoder().decode(key.value).trim().length > 0,
      liveModel: config.model,
      backendModel: config.delegation.model,
    };
  });
  const updateSettings = Effect.fn("VoiceLiveBroker.updateSettings")(function* (
    input: VoiceSettingsUpdate,
  ) {
    const config = yield* loadBrokerConfig(secrets);
    const encoded = yield* encodeBrokerConfig({
      liveModel: input.liveModel,
      backendModel: input.backendModel,
      instructions: config.instructions,
      delegationInstructions: config.delegation.instructions,
    }).pipe(Effect.mapError(settingsFailure));
    yield* secrets
      .set(VOICE_BROKER_CONFIG_SECRET_NAME, new TextEncoder().encode(encoded))
      .pipe(Effect.mapError(settingsFailure));
    if (input.apiKey === null) {
      yield* secrets.remove(OPENAI_API_KEY_SECRET_NAME).pipe(Effect.mapError(settingsFailure));
    } else if (input.apiKey !== undefined) {
      yield* secrets
        .set(OPENAI_API_KEY_SECRET_NAME, new TextEncoder().encode(input.apiKey))
        .pipe(Effect.mapError(settingsFailure));
    }
    return yield* getSettings();
  });

  const requireSession = Effect.fn("VoiceLiveBroker.requireSession")(function* (
    sessionId: VoiceSessionId,
  ) {
    const retained = (yield* Ref.get(sessions)).get(sessionId);
    if (retained === undefined) {
      return yield* brokerInvalidRequest(
        `Unknown voice session ${String(sessionId)}. The broker only knows sessions it minted in this server process.`,
        404,
      );
    }
    return retained;
  });

  const mintSession = Effect.fn("VoiceLiveBroker.mintSession")(function* (
    input: VoiceBrokerSessionRequest,
  ) {
    const config = yield* loadBrokerConfig(secrets);
    const key = yield* secrets
      .get(OPENAI_API_KEY_SECRET_NAME)
      .pipe(
        Effect.catch((cause) =>
          Effect.logError("failed to read the OpenAI API key secret", { cause }).pipe(
            Effect.as(Option.none<Uint8Array>()),
          ),
        ),
      );
    if (Option.isNone(key)) {
      return yield* new VoiceBrokerError({
        code: "auth_invalid",
        message: "This environment has no OpenAI API key configured for voice sessions.",
        status: 401,
      });
    }

    const upstreamBody = {
      session: {
        model: config.model,
        instructions:
          config.instructions === undefined
            ? DEFAULT_LIVE_INSTRUCTIONS
            : `${config.instructions}\n${ACTION_FEEDBACK_POLICY}\n${EXISTING_THREAD_POLICY}`,
        delegation: input.clientDelegation
          ? undefined
          : {
              type: "responses",
              responses: {
                model: config.delegation.model,
                instructions:
                  config.delegation.instructions === undefined
                    ? DEFAULT_DELEGATION_INSTRUCTIONS
                    : `${config.delegation.instructions}\n${ACTION_FEEDBACK_POLICY}\n${EXISTING_THREAD_POLICY}`,
                tools: (Object.keys(VoiceToolSchemas) as Array<keyof typeof VoiceToolSchemas>).map(
                  (name) => {
                    const document = Schema.toJsonSchemaDocument(
                      Schema.toEncoded(VoiceToolSchemas[name].input),
                    );
                    return {
                      type: "function",
                      name,
                      description: VOICE_TOOL_DESCRIPTIONS[name],
                      // Effect's empty struct also accepts arrays; function arguments must be an object.
                      parameters:
                        name === "discoverEnvironments"
                          ? { type: "object", properties: {}, additionalProperties: false }
                          : { ...document.schema, $defs: document.definitions },
                      strict: false,
                    };
                  },
                ),
              },
            },
      },
      transport: { type: input.transport.type, sdp: input.transport.sdp },
    };
    const response = yield* httpClient
      .post(OPENAI_LIVE_SESSIONS_URL, {
        headers: { authorization: `Bearer ${new TextDecoder().decode(key.value)}` },
        body: HttpBody.jsonUnsafe(upstreamBody),
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("OpenAI Live session request failed", { cause }).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                upstreamFailureError(500, "the Live session endpoint could not be reached"),
              ),
            ),
          ),
        ),
      );

    if (response.status < 200 || response.status >= 300) {
      const detail = yield* response.text.pipe(
        Effect.map((text) => {
          const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(UpstreamErrorBody))(text);
          if (decoded._tag === "Success") {
            const message = decoded.value.error?.message;
            if (message !== undefined) {
              return message;
            }
          }
          return `HTTP ${response.status}`;
        }),
        Effect.orElseSucceed(() => `HTTP ${response.status}`),
      );
      return yield* upstreamFailureError(response.status, detail);
    }

    const body = yield* response.json.pipe(
      Effect.mapError(() =>
        upstreamFailureError(response.status, "the Live session response was unreadable"),
      ),
    );
    const decoded = Schema.decodeUnknownExit(UpstreamLiveSessionCreated)(body);
    if (decoded._tag === "Failure") {
      return yield* new VoiceBrokerError({
        code: "environment_unreachable",
        message:
          "OpenAI Live session response did not match the documented shape (session.id and transport.sdp).",
        status: 502,
      });
    }
    const sessionId = VoiceSessionId.make(decoded.value.session.id);
    yield* Ref.update(sessions, (map) => {
      const next = new Map(map);
      next.set(sessionId, { status: "open", clientDelegation: input.clientDelegation === true });
      return next;
    });
    return {
      sessionId,
      sdp: decoded.value.transport.sdp,
    } satisfies VoiceBrokerSessionCreated;
  });

  const respond = Effect.fn("VoiceLiveBroker.respond")(function* (input: VoiceBackendRequest) {
    const retained = yield* requireSession(input.sessionId);
    if (retained.status !== "open" || !retained.clientDelegation) {
      return yield* brokerInvalidRequest(
        "The command backend requires an open client-delegation session.",
      );
    }
    const encoded = yield* encodeBackendInput(input.input).pipe(
      Effect.mapError(() => upstreamFailureError(400, "invalid backend input")),
    );
    if (encoded.length > 128_000) {
      return yield* brokerInvalidRequest(
        "Voice command context is full. Start a fresh voice session.",
      );
    }
    const config = yield* loadBrokerConfig(secrets);
    const key = yield* secrets
      .get(OPENAI_API_KEY_SECRET_NAME)
      .pipe(Effect.mapError(() => upstreamFailureError(401, "the backend key could not be read")));
    if (Option.isNone(key))
      return yield* upstreamFailureError(401, "the backend key is unavailable");
    const tools = (Object.keys(VoiceToolSchemas) as Array<keyof typeof VoiceToolSchemas>).map(
      (name) => {
        const document = Schema.toJsonSchemaDocument(
          Schema.toEncoded(VoiceToolSchemas[name].input),
        );
        return {
          type: "function",
          name,
          description: VOICE_TOOL_DESCRIPTIONS[name],
          strict: false,
          parameters:
            name === "discoverEnvironments"
              ? { type: "object", properties: {}, additionalProperties: false }
              : { ...document.schema, $defs: document.definitions },
        };
      },
    );
    const response = yield* httpClient
      .post("https://api.openai.com/v1/responses", {
        headers: { authorization: `Bearer ${new TextDecoder().decode(key.value)}` },
        body: HttpBody.jsonUnsafe({
          model: config.delegation.model,
          instructions:
            (config.delegation.instructions === undefined
              ? DEFAULT_DELEGATION_INSTRUCTIONS
              : `${config.delegation.instructions}\n${ACTION_FEEDBACK_POLICY}\n${EXISTING_THREAD_POLICY}`) +
            "\nApplication results in the history describe actions already completed. Do not repeat them. " +
            "Use provided current UI context to resolve references. Never claim a draft is a running worker. " +
            "Return a short factual answer or ask one clarification when necessary.",
          input: input.input,
          tools,
          store: false,
          include: ["reasoning.encrypted_content"],
        }),
      })
      .pipe(
        Effect.mapError(() =>
          upstreamFailureError(500, "the Responses backend could not be reached"),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      const detail = yield* response.text.pipe(
        Effect.orElseSucceed(() => `HTTP ${response.status}`),
      );
      return yield* upstreamFailureError(response.status, detail.slice(0, 1000));
    }
    const body = yield* response.json.pipe(
      Effect.mapError(() => upstreamFailureError(500, "unreadable backend response")),
    );
    return yield* decodeBackendResult(body).pipe(
      Effect.mapError(() => upstreamFailureError(500, "unexpected backend response shape")),
    );
  });

  const closeSession = Effect.fn("VoiceLiveBroker.closeSession")(function* (
    input: VoiceBrokerSessionCloseInput,
  ) {
    const retained = yield* requireSession(input.sessionId);
    if (retained.status === "open") {
      yield* Ref.update(sessions, (map) => {
        const next = new Map(map);
        next.set(input.sessionId, { ...retained, status: "closed" });
        return next;
      });
    }
    return { closed: true } satisfies VoiceBrokerSessionCloseResult;
  });

  const recordSessionUsage = Effect.fn("VoiceLiveBroker.recordSessionUsage")(function* (
    usage: VoiceSessionUsage,
  ) {
    const retained = yield* requireSession(usage.sessionId);
    const stored: VoiceSessionUsage = { ...usage };
    yield* Ref.update(sessions, (map) => {
      const next = new Map(map);
      next.set(usage.sessionId, { ...retained, lastUsage: stored });
      return next;
    });
    return stored;
  });

  const getSessionUsage = Effect.fn("VoiceLiveBroker.getSessionUsage")(function* (
    input: VoiceBrokerSessionCloseInput,
  ) {
    const retained = yield* requireSession(input.sessionId);
    if (retained.lastUsage !== undefined) {
      return retained.lastUsage;
    }
    return {
      sessionId: input.sessionId,
      recordedAt: DateTime.formatIso(yield* DateTime.now),
      usage: {},
    } satisfies VoiceSessionUsage;
  });

  return VoiceLiveBroker.of({
    getSettings,
    updateSettings,
    respond,
    mintSession,
    closeSession,
    recordSessionUsage,
    getSessionUsage,
  });
});

export const VoiceLiveBrokerLive = Layer.effect(VoiceLiveBroker, makeBroker);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Every broker route requires `orchestration:operate`: minting a Live
    session incurs charges, and close/usage expose the same session's
    accounting. Read-only sessions get the existing `insufficient_scope`
    semantics. */
const authenticateVoiceBrokerRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
  return session;
});

const decodeJsonBody = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
): Effect.Effect<A, VoiceBrokerError, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* request.json.pipe(
      Effect.mapError(() => brokerInvalidRequest("The request body must be JSON.")),
    );
    return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
      Effect.mapError(() =>
        brokerInvalidRequest("The request body does not match the voice broker schema."),
      ),
    );
  });

type VoiceBrokerRouteError =
  | EnvironmentAuthInvalidError
  | EnvironmentInternalError
  | EnvironmentScopeRequiredError
  | VoiceBrokerError;

const withBrokerErrorResponses = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, VoiceBrokerRouteError, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      VoiceBrokerError: voiceBrokerErrorResponse,
    }),
  ) as Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>;

const mintSessionRoute = (broker: VoiceLiveBroker["Service"]) =>
  withBrokerErrorResponses(
    Effect.gen(function* () {
      yield* authenticateVoiceBrokerRequest;
      const input = yield* decodeJsonBody(VoiceBrokerSessionRequest);
      const created = yield* broker.mintSession(input);
      return HttpServerResponse.jsonUnsafe(created);
    }),
  );

const closeSessionRoute = (broker: VoiceLiveBroker["Service"]) =>
  withBrokerErrorResponses(
    Effect.gen(function* () {
      yield* authenticateVoiceBrokerRequest;
      const input = yield* decodeJsonBody(VoiceBrokerSessionCloseInput);
      const result = yield* broker.closeSession(input);
      return HttpServerResponse.jsonUnsafe(result);
    }),
  );

const backendRoute = (broker: VoiceLiveBroker["Service"]) =>
  withBrokerErrorResponses(
    Effect.gen(function* () {
      yield* authenticateVoiceBrokerRequest;
      const input = yield* decodeJsonBody(VoiceBackendRequest);
      return HttpServerResponse.jsonUnsafe(yield* broker.respond(input));
    }),
  );

const recordSessionUsageRoute = (broker: VoiceLiveBroker["Service"]) =>
  withBrokerErrorResponses(
    Effect.gen(function* () {
      yield* authenticateVoiceBrokerRequest;
      const usage = yield* decodeJsonBody(VoiceSessionUsage);
      const stored = yield* broker.recordSessionUsage(usage);
      return HttpServerResponse.jsonUnsafe(stored);
    }),
  );

const getSessionUsageRoute = (broker: VoiceLiveBroker["Service"]) =>
  withBrokerErrorResponses(
    Effect.gen(function* () {
      yield* authenticateVoiceBrokerRequest;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      const sessionId = url._tag === "Some" ? url.value.searchParams.get("sessionId") : null;
      if (sessionId === null || sessionId.length === 0) {
        return yield* brokerInvalidRequest("The sessionId query parameter is required.");
      }
      const usage = yield* broker.getSessionUsage({ sessionId: VoiceSessionId.make(sessionId) });
      return HttpServerResponse.jsonUnsafe(usage);
    }),
  );

const voiceSettingsRoute = (broker: VoiceLiveBroker["Service"], update: boolean) =>
  withBrokerErrorResponses(
    Effect.gen(function* () {
      const session = yield* authenticateVoiceBrokerRequest;
      if (!session.scopes.includes(AuthAccessWriteScope)) {
        return yield* failEnvironmentScopeRequired(AuthAccessWriteScope);
      }
      const result = update
        ? yield* broker.updateSettings(yield* decodeJsonBody(VoiceSettingsUpdate))
        : yield* broker.getSettings();
      return HttpServerResponse.jsonUnsafe(result, { headers: { "cache-control": "no-store" } });
    }),
  );

/** The four broker route handlers for one broker instance, exported for
    focused tests. */
export const voiceBrokerRouteHandlers = (broker: VoiceLiveBroker["Service"]) => ({
  getSettings: voiceSettingsRoute(broker, false),
  updateSettings: voiceSettingsRoute(broker, true),
  respond: backendRoute(broker),
  mintSession: mintSessionRoute(broker),
  closeSession: closeSessionRoute(broker),
  recordUsage: recordSessionUsageRoute(broker),
  getUsage: getSessionUsageRoute(broker),
});

export const voiceBrokerRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const broker = yield* VoiceLiveBroker;
    return Layer.mergeAll(
      HttpRouter.add("POST", "/api/voice/settings/read", voiceSettingsRoute(broker, false)),
      HttpRouter.add("POST", "/api/voice/settings", voiceSettingsRoute(broker, true)),
      HttpRouter.add("POST", VOICE_BACKEND_PATH, backendRoute(broker)),
      HttpRouter.add("POST", VOICE_BROKER_SESSIONS_PATH, mintSessionRoute(broker)),
      HttpRouter.add("POST", VOICE_BROKER_CLOSE_PATH, closeSessionRoute(broker)),
      HttpRouter.add("POST", VOICE_BROKER_USAGE_PATH, recordSessionUsageRoute(broker)),
      HttpRouter.add("GET", VOICE_BROKER_USAGE_PATH, getSessionUsageRoute(broker)),
    );
  }),
).pipe(Layer.provide(VoiceLiveBrokerLive));
