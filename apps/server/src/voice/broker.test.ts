import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  VoiceSessionId,
  VoiceSessionUsage,
  VoiceBrokerSessionCreated,
  VoiceBrokerSessionRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { FetchHttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  DEFAULT_DELEGATION_INSTRUCTIONS,
  OPENAI_API_KEY_SECRET_NAME,
  VoiceLiveBroker,
  VoiceLiveBrokerLive,
  voiceBrokerRouteHandlers,
} from "./broker.ts";

// ---------------------------------------------------------------------------
// Fakes: no network and no filesystem here. The OpenAI endpoint is a mocked
// fetch, the key store an in-memory secret store, and authentication a
// token -> scopes lookup. The broker service is rebuilt per test, so retained
// session state never leaks between tests.
// ---------------------------------------------------------------------------

const OPERATE_TOKEN = "token-operate";
const ADMIN_TOKEN = "token-admin";
const READ_TOKEN = "token-read";
const REVOKED_TOKEN = "token-revoked";

const usageInput = (sessionId: string): VoiceSessionUsage => ({
  sessionId: VoiceSessionId.make(sessionId),
  recordedAt: "2026-09-11T00:00:00.000Z",
  usage: { input_tokens: 12, output_tokens: 34 },
});

interface RecordedUpstreamRequest {
  readonly authorization: string | undefined;
  readonly url: string;
  readonly body: unknown;
}

interface UpstreamResponse {
  readonly status: number;
  readonly body: unknown;
}

interface UpstreamRecorder {
  readonly recorded: Array<RecordedUpstreamRequest>;
  readonly queue: Array<UpstreamResponse>;
}

const makeUpstreamFetch = (state: UpstreamRecorder): typeof fetch => {
  const fetchLike = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const input = args[0];
    const init = args[1];
    const headers = new Headers(init?.headers);
    let bodyText = "";
    const rawBody = init?.body;
    if (typeof rawBody === "string") {
      bodyText = rawBody;
    } else if (rawBody instanceof Uint8Array) {
      bodyText = new TextDecoder().decode(rawBody);
    } else if (rawBody !== undefined) {
      bodyText = await new Response(rawBody).text();
    }
    let body: unknown = undefined;
    if (bodyText.length > 0) {
      const parsed = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown))(bodyText);
      body = parsed._tag === "Success" ? parsed.value : bodyText;
    }
    state.recorded.push({
      authorization: headers.get("authorization") ?? undefined,
      url: String(input),
      body,
    });
    const next = state.queue.shift();
    const payload = next?.body ??
      // The documented success shape (voice-webrtc guide): session.id plus
      // transport.sdp.
      { session: { id: "live_sess_1" }, transport: { type: "webrtc", sdp: "answer-sdp" } };
    const payloadText = typeof payload === "string" ? payload : JSON.stringify(payload);
    return Promise.resolve(new Response(payloadText, { status: next?.status ?? 200 }));
  };
  return fetchLike as typeof fetch;
};

const makeSecretStoreLayer = (values: Record<string, string>) =>
  Layer.mock(ServerSecretStore)({
    set: (name, value) =>
      Effect.sync(() => {
        values[name] = new TextDecoder().decode(value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        delete values[name];
      }),
    get: (name: string) =>
      name in values
        ? Effect.succeed(Option.some(new TextEncoder().encode(values[name] ?? "")))
        : Effect.succeed(Option.none()),
  });

const makeEnvironmentAuthLayer = () =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
      const authorization = request.headers["authorization"];
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      if (token === REVOKED_TOKEN) {
        return Effect.fail(
          new EnvironmentAuth.ServerAuthInvalidCredentialError({
            cause: new Error("session revoked"),
          }),
        );
      }
      if (token === OPERATE_TOKEN || token === ADMIN_TOKEN) {
        return Effect.succeed({
          sessionId: "session-operate" as never,
          subject: "test-operate",
          method: "bearer-access-token" as const,
          scopes: [
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
            ...(token === ADMIN_TOKEN ? [AuthAccessWriteScope] : []),
          ],
        });
      }
      if (token === READ_TOKEN) {
        return Effect.succeed({
          sessionId: "session-read" as never,
          subject: "test-read",
          method: "bearer-access-token" as const,
          scopes: [AuthOrchestrationReadScope],
        });
      }
      return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError());
    },
  });

const makeTest = (options?: {
  readonly secrets?: Record<string, string>;
  readonly upstream?: (state: UpstreamRecorder) => void;
}) =>
  Effect.gen(function* () {
    const state: UpstreamRecorder = { recorded: [], queue: [] };
    if (options?.upstream !== undefined) {
      options.upstream(state);
    }
    const context = yield* Layer.build(
      VoiceLiveBrokerLive.pipe(
        Layer.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, makeUpstreamFetch(state))),
          ),
        ),
        Layer.provide(
          makeSecretStoreLayer(options?.secrets ?? { [OPENAI_API_KEY_SECRET_NAME]: "test-key" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    );
    const broker = Context.get(context, VoiceLiveBroker);
    return { state, handlers: voiceBrokerRouteHandlers(broker) };
  });

const MINT_PATH = "/api/voice/sessions";
const CLOSE_PATH = "/api/voice/sessions/close";
const USAGE_PATH = "/api/voice/sessions/usage";

const runHandler = (
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    EnvironmentAuth.EnvironmentAuth | HttpServerRequest.HttpServerRequest
  >,
  input: {
    readonly method: string;
    readonly path: string;
    readonly token?: string;
    readonly body?: unknown;
  },
): Effect.Effect<Response, never, EnvironmentAuth.EnvironmentAuth> =>
  Effect.map(
    Effect.provideService(
      handler,
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(`https://environment.test${input.path}`, {
          method: input.method,
          headers: input.token === undefined ? {} : { authorization: `Bearer ${input.token}` },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        }),
      ),
    ),
    HttpServerResponse.toWeb,
  );

const responseBody = (response: Response): Effect.Effect<any> =>
  Effect.promise(() => response.json() as Promise<any>);

describe("voice broker routes", () => {
  it.effect("supports an opt-in client session and its authenticated Responses fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, handlers } = yield* makeTest();
        yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { clientDelegation: true, transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(state.recorded[0]?.body).not.toHaveProperty("session.delegation");
        state.queue.push({ status: 200, body: { status: "completed", output: [] } });
        const response = yield* runHandler(handlers.respond, {
          method: "POST",
          path: "/api/voice/backend",
          token: OPERATE_TOKEN,
          body: { sessionId: "live_sess_1", input: [{ role: "user", content: "Find the plan" }] },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(200);
        expect(state.recorded[1]).toMatchObject({
          url: "https://api.openai.com/v1/responses",
          body: {
            model: "gpt-5.6-terra",
            store: false,
            include: ["reasoning.encrypted_content"],
          },
        });
        yield* runHandler(handlers.closeSession, {
          method: "POST",
          path: CLOSE_PATH,
          token: OPERATE_TOKEN,
          body: { sessionId: "live_sess_1" },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        const closed = yield* runHandler(handlers.respond, {
          method: "POST",
          path: "/api/voice/backend",
          token: OPERATE_TOKEN,
          body: { sessionId: "live_sess_1", input: [] },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(closed.status).toBe(400);
        expect(state.recorded).toHaveLength(2);
      }),
    ),
  );
  it.effect("denies unauthenticated, revoked and read-only backend requests before upstream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, handlers } = yield* makeTest();
        for (const token of [READ_TOKEN, REVOKED_TOKEN]) {
          const result = yield* runHandler(handlers.respond, {
            method: "POST",
            path: "/api/voice/backend",
            token,
            body: { sessionId: "live_sess_1", input: [] },
          }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
          expect(result.status).toBe(token === READ_TOKEN ? 403 : 401);
        }
        const absent = yield* runHandler(handlers.respond, {
          method: "POST",
          path: "/api/voice/backend",
          body: { sessionId: "live_sess_1", input: [] },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(absent.status).toBe(401);
        expect(state.recorded).toHaveLength(0);
      }),
    ),
  );
  it.effect("tells Live to delegate T3 lookups before making access or success claims", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, handlers } = yield* makeTest();
        yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(state.recorded[0]?.body).toMatchObject({
          session: {
            instructions: expect.stringContaining(
              "Delegate all requests about T3 projects or threads to the backend",
            ),
          },
        });
        expect(state.recorded[0]?.body).toMatchObject({
          session: {
            instructions: expect.stringContaining("a title is not evidence of contents"),
          },
        });
      }),
    ),
  );
  it("rejects empty SDP without trimming valid SDP", () => {
    for (const sdp of ["", " \r\n\t"]) {
      expect(
        Schema.decodeUnknownExit(VoiceBrokerSessionRequest)({ transport: { type: "webrtc", sdp } })
          ._tag,
      ).toBe("Failure");
      expect(
        Schema.decodeUnknownExit(VoiceBrokerSessionCreated)({ sessionId: "live_sess_1", sdp })._tag,
      ).toBe("Failure");
    }
  });
  it.effect("places model, instructions and parameter schemas inside delegation.responses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, handlers } = yield* makeTest();
        yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(state.recorded[0]?.body).toMatchObject({
          session: {
            delegation: {
              type: "responses",
              responses: {
                model: "gpt-5.6-terra",
                instructions: DEFAULT_DELEGATION_INSTRUCTIONS,
                tools: expect.arrayContaining([
                  expect.objectContaining({
                    type: "function",
                    name: "discoverEnvironments",
                    parameters: { type: "object", properties: {}, additionalProperties: false },
                  }),
                  expect.objectContaining({
                    type: "function",
                    name: "searchThreads",
                    strict: false,
                    parameters: expect.objectContaining({
                      type: "object",
                      properties: expect.objectContaining({ query: expect.anything() }),
                    }),
                  }),
                ]),
              },
            },
          },
        });
        expect(state.recorded[0]?.body).not.toHaveProperty("session.tools");
      }),
    ),
  );
  it.effect("preserves SDP line endings across request validation and answer decoding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, handlers } = yield* makeTest();
        const sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(200);
        expect(state.recorded[0]?.body).toMatchObject({ transport: { sdp } });
        const answer = yield* Schema.decodeUnknownEffect(VoiceBrokerSessionCreated)({
          sessionId: "live_sess_1",
          sdp,
        });
        expect(answer.sdp).toBe(sdp);
      }),
    ),
  );

  it.effect("rejects a read-only session with insufficient_scope and never calls upstream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, handlers } = yield* makeTest();
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: READ_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(403);
        expect(yield* responseBody(response)).toMatchObject({ code: "insufficient_scope" });
        expect(state.recorded).toHaveLength(0);
      }),
    ),
  );

  it.effect("requires operate scope on the close and usage routes too", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest();
        const envAuth = makeEnvironmentAuthLayer();
        const closeResponse = yield* runHandler(handlers.closeSession, {
          method: "POST",
          path: CLOSE_PATH,
          token: READ_TOKEN,
          body: { sessionId: "live_sess_1" },
        }).pipe(Effect.provide(envAuth));
        expect(closeResponse.status).toBe(403);

        const usageResponse = yield* runHandler(handlers.getUsage, {
          method: "GET",
          path: `${USAGE_PATH}?sessionId=live_sess_1`,
          token: READ_TOKEN,
        }).pipe(Effect.provide(envAuth));
        expect(usageResponse.status).toBe(403);
      }),
    ),
  );

  it.effect("maps a revoked session to auth_invalid", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest();
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: REVOKED_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(401);
        expect(yield* responseBody(response)).toMatchObject({ code: "auth_invalid" });
      }),
    ),
  );

  it.effect("rejects malformed request bodies with invalid_request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest();
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "websocket", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(400);
        expect(yield* responseBody(response)).toMatchObject({ code: "invalid_request" });
      }),
    ),
  );

  it.effect("proxies the SDP exchange with the environment-owned key and retains the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, handlers } = yield* makeTest();
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(200);
        const created = yield* responseBody(response);
        expect(created).toMatchObject({ sessionId: "live_sess_1", sdp: "answer-sdp" });

        expect(state.recorded).toHaveLength(1);
        const upstream = state.recorded[0]!;
        expect(upstream.url).toBe("https://api.openai.com/v1/live/sessions");
        expect(upstream.authorization).toBe("Bearer test-key");
        const upstreamBody = upstream.body as {
          session: {
            delegation: {
              type: string;
              responses: { model: string; tools: Array<{ name: string }> };
            };
          };
          transport: { type: string; sdp: string };
        };
        // Responses delegation with a small backend model, and the frozen
        // voice tool names advertised with execution left client-owned.
        expect(upstreamBody.session.delegation).toMatchObject({ type: "responses" });
        expect(upstreamBody.session.delegation.responses.model.length).toBeGreaterThan(0);
        expect(upstreamBody.session.delegation.responses.tools.map((tool) => tool.name)).toContain(
          "searchThreads",
        );
        // Client-local UI control tools are advertised like every other tool.
        expect(upstreamBody.session.delegation.responses.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["listControls", "clickControl"]),
        );
        expect(upstreamBody.transport).toEqual({ type: "webrtc", sdp: "offer-sdp" });
      }),
    ),
  );

  it.effect("decodes the exact documented Live response shape", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Verbatim shape from the voice-webrtc guide, "Read the session
        // response": HTTP 201 with session.id and transport.sdp.
        const { handlers } = yield* makeTest({
          upstream: (state) => {
            state.queue.push({
              status: 201,
              body: {
                session: { id: "live_123" },
                transport: { type: "webrtc", sdp: "<SDP answer>" },
              },
            });
          },
        });
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(200);
        const created = yield* responseBody(response);
        expect(created).toEqual({ sessionId: "live_123", sdp: "<SDP answer>" });
      }),
    ),
  );

  it.effect(
    "rejects a documented-shape response missing session identity without inventing one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handlers } = yield* makeTest({
            upstream: (state) => {
              state.queue.push({
                status: 200,
                body: { transport: { type: "webrtc", sdp: "<SDP answer>" } },
              });
            },
          });
          const response = yield* runHandler(handlers.mintSession, {
            method: "POST",
            path: MINT_PATH,
            token: OPERATE_TOKEN,
            body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
          }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
          expect(response.status).toBe(502);
          const body = (yield* responseBody(response)) as { code: string };
          expect(body.code).toBe("environment_unreachable");
        }),
      ),
  );

  it.effect("supports configurable live and delegation models via broker config secret", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { state, handlers } = yield* makeTest({
          secrets: {
            [OPENAI_API_KEY_SECRET_NAME]: "test-key",
            // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture config payload.
            "voice-broker-config": JSON.stringify({
              liveModel: "gpt-live-custom",
              backendModel: "gpt-small-custom",
            }),
          },
        });
        yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        const upstreamBody = state.recorded[0]!.body as {
          session: { model: string; delegation: { responses: { model: string } } };
        };
        expect(upstreamBody.session.model).toBe("gpt-live-custom");
        expect(upstreamBody.session.delegation.responses.model).toBe("gpt-small-custom");
      }),
    ),
  );

  it.effect("maps upstream credential failures to auth_invalid", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest({
          upstream: (state) => {
            state.queue.push({ status: 401, body: { error: { message: "bad key" } } });
          },
        });
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(401);
        expect(yield* responseBody(response)).toMatchObject({ code: "auth_invalid" });
      }),
    ),
  );

  it.effect("maps upstream 5xx failures to environment_unreachable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest({
          upstream: (state) => {
            state.queue.push({ status: 500, body: "Internal Server Error" });
          },
        });
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(502);
        expect(yield* responseBody(response)).toMatchObject({ code: "environment_unreachable" });
      }),
    ),
  );

  it.effect("maps upstream 4xx rejections to invalid_request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest({
          upstream: (state) => {
            state.queue.push({ status: 400, body: { error: { message: "bad sdp" } } });
          },
        });
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(400);
        expect(yield* responseBody(response)).toMatchObject({ code: "invalid_request" });
      }),
    ),
  );

  it.effect("maps an upstream response without an answer SDP to environment_unreachable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest({
          upstream: (state) => {
            state.queue.push({ status: 200, body: { session: { id: "live_sess_1" } } });
          },
        });
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(502);
        expect(yield* responseBody(response)).toMatchObject({ code: "environment_unreachable" });
      }),
    ),
  );

  it.effect("reports auth_invalid when the environment has no OpenAI key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest({ secrets: {} });
        const response = yield* runHandler(handlers.mintSession, {
          method: "POST",
          path: MINT_PATH,
          token: OPERATE_TOKEN,
          body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(401);
        expect(yield* responseBody(response)).toMatchObject({ code: "auth_invalid" });
      }),
    ),
  );

  it.effect("tracks close accounting and last usage for retained sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest();
        const envAuth = makeEnvironmentAuthLayer();

        const closeUnknown = yield* runHandler(handlers.closeSession, {
          method: "POST",
          path: CLOSE_PATH,
          token: OPERATE_TOKEN,
          body: { sessionId: "live_unknown" },
        }).pipe(Effect.provide(envAuth));
        expect(closeUnknown.status).toBe(404);
        expect(yield* responseBody(closeUnknown)).toMatchObject({ code: "invalid_request" });

        const minted = yield* responseBody(
          yield* runHandler(handlers.mintSession, {
            method: "POST",
            path: MINT_PATH,
            token: OPERATE_TOKEN,
            body: { transport: { type: "webrtc", sdp: "offer-sdp" } },
          }).pipe(Effect.provide(envAuth)),
        );
        const sessionId = minted.sessionId as string;

        const stored = yield* responseBody(
          yield* runHandler(handlers.recordUsage, {
            method: "POST",
            path: USAGE_PATH,
            token: OPERATE_TOKEN,
            body: usageInput(sessionId),
          }).pipe(Effect.provide(envAuth)),
        );
        expect(stored.usage).toMatchObject({ input_tokens: 12 });

        const closed = yield* responseBody(
          yield* runHandler(handlers.closeSession, {
            method: "POST",
            path: CLOSE_PATH,
            token: OPERATE_TOKEN,
            body: { sessionId },
          }).pipe(Effect.provide(envAuth)),
        );
        expect(closed).toEqual({ closed: true });

        // Usage survives close; closing again is idempotent.
        const usageAfterClose = yield* responseBody(
          yield* runHandler(handlers.getUsage, {
            method: "GET",
            path: `${USAGE_PATH}?sessionId=${sessionId}`,
            token: OPERATE_TOKEN,
          }).pipe(Effect.provide(envAuth)),
        );
        expect(usageAfterClose.usage).toMatchObject({ input_tokens: 12, output_tokens: 34 });

        const closedAgain = yield* responseBody(
          yield* runHandler(handlers.closeSession, {
            method: "POST",
            path: CLOSE_PATH,
            token: OPERATE_TOKEN,
            body: { sessionId },
          }).pipe(Effect.provide(envAuth)),
        );
        expect(closedAgain).toEqual({ closed: true });
      }),
    ),
  );

  it.effect("requires the sessionId query parameter on usage reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* makeTest();
        const response = yield* runHandler(handlers.getUsage, {
          method: "GET",
          path: USAGE_PATH,
          token: OPERATE_TOKEN,
        }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
        expect(response.status).toBe(400);
        expect(yield* responseBody(response)).toMatchObject({ code: "invalid_request" });
      }),
    ),
  );

  it("pins the session-status semantics in the delegation instructions", () => {
    // The instruction text is the contract with the backend model: an
    // in-band error must never be announced as success. These phrases are
    // the required semantics; future edits to the instructions must keep
    // every one of them.
    expect(DEFAULT_DELEGATION_INSTRUCTIONS).toMatch(
      /voice\.startThread: the thread started only when the returned session\.status is "starting", "running", or "ready"/,
    );
    expect(DEFAULT_DELEGATION_INSTRUCTIONS).toMatch(
      /session\.status of "error" means the worker failed to start: say so and speak the session\.lastError text to the user/,
    );
    // Reviewer-ruled wording: idle/missing is "unconfirmed", never a definite
    // claim in either direction.
    expect(DEFAULT_DELEGATION_INSTRUCTIONS).toMatch(/could not be confirmed/);
    expect(DEFAULT_DELEGATION_INSTRUCTIONS).toMatch(
      /do not announce success and do not announce definite failure/,
    );
    expect(DEFAULT_DELEGATION_INSTRUCTIONS).toMatch(/do not announce success/);
    // Reviewer-accepted: interrupted/stopped are reported verbatim.
    expect(DEFAULT_DELEGATION_INSTRUCTIONS).toMatch(
      /"interrupted" or "stopped" means a worker was on the thread but is not running now/,
    );
    // Reviewer-accepted: per-environment results succeed or fail per
    // environment; the whole result fails only when nothing usable exists.
    expect(DEFAULT_DELEGATION_INSTRUCTIONS).toMatch(
      /The whole result is a failure only when no environment has status "ok" or "partial"/,
    );
    expect(DEFAULT_DELEGATION_INSTRUCTIONS).toMatch(/never reframed as success/);
  });
});

describe("voice settings", () => {
  it.effect("requires administrator access before reading or writing settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secrets = { [OPENAI_API_KEY_SECRET_NAME]: "existing-key" };
        const { handlers } = yield* makeTest({ secrets });
        for (const token of [READ_TOKEN, OPERATE_TOKEN]) {
          for (const handler of [handlers.getSettings, handlers.updateSettings]) {
            const result = yield* runHandler(handler, {
              method: "POST",
              path: "/api/voice/settings",
              token,
              body: { apiKey: "new-key", liveModel: "speech", backendModel: "reasoning" },
            }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
            expect(result.status).toBe(403);
          }
        }
        expect(secrets[OPENAI_API_KEY_SECRET_NAME]).toBe("existing-key");
      }),
    ),
  );
  it.effect(
    "saves models, preserves the key and instructions, rotates and removes the key without exposing it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const secrets: Record<string, string> = {
            [OPENAI_API_KEY_SECRET_NAME]: "existing-key",
            "voice-broker-config":
              '{"instructions":"custom speech","delegationInstructions":"custom reasoning"}',
          };
          const { handlers, state } = yield* makeTest({ secrets });
          const update = (body: unknown) =>
            runHandler(handlers.updateSettings, {
              method: "POST",
              path: "/api/voice/settings",
              token: ADMIN_TOKEN,
              body,
            }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
          const result = yield* update({
            liveModel: "speech-custom",
            backendModel: "reasoning-custom",
          });
          expect(result.status).toBe(200);
          expect(yield* responseBody(result)).toEqual({
            keyConfigured: true,
            liveModel: "speech-custom",
            backendModel: "reasoning-custom",
          });
          expect(secrets[OPENAI_API_KEY_SECRET_NAME]).toBe("existing-key");
          expect(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
              secrets["voice-broker-config"],
            ),
          ).toMatchObject({
            instructions: "custom speech",
            delegationInstructions: "custom reasoning",
          });
          yield* update({
            apiKey: "replacement-key",
            liveModel: "speech-custom",
            backendModel: "reasoning-custom",
          });
          yield* runHandler(handlers.mintSession, {
            method: "POST",
            path: MINT_PATH,
            token: OPERATE_TOKEN,
            body: { transport: { type: "webrtc", sdp: "offer" } },
          }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
          expect(state.recorded[0]).toMatchObject({
            authorization: "Bearer replacement-key",
            body: {
              session: {
                model: "speech-custom",
                delegation: { responses: { model: "reasoning-custom" } },
              },
            },
          });
          const removed = yield* update({
            apiKey: null,
            liveModel: "speech-custom",
            backendModel: "reasoning-custom",
          });
          expect(yield* responseBody(removed)).toMatchObject({ keyConfigured: false });
          const mint = yield* runHandler(handlers.mintSession, {
            method: "POST",
            path: MINT_PATH,
            token: OPERATE_TOKEN,
            body: { transport: { type: "webrtc", sdp: "offer" } },
          }).pipe(Effect.provide(makeEnvironmentAuthLayer()));
          expect(mint.status).toBe(401);
          const invalid = yield* update({ apiKey: "", liveModel: "", backendModel: "reasoning" });
          expect(invalid.status).toBe(400);
          expect(secrets[OPENAI_API_KEY_SECRET_NAME]).toBeUndefined();
        }),
      ),
  );
});
