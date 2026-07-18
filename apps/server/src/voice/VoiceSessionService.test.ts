import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceSessionService from "./VoiceSessionService.ts";

function makeTestLayer(
  response: (request: HttpClientRequest.HttpClientRequest) => Response = () =>
    Response.json({ value: "ephemeral-secret", expires_at: 1_800_000_000 }),
) {
  const secrets = new Map<string, Uint8Array>();
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response(request))),
  );
  const secretStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => secrets.set(name, value)).pipe(Effect.asVoid),
    remove: (name) => Effect.sync(() => secrets.delete(name)).pipe(Effect.asVoid),
  });

  return {
    execute,
    layer: VoiceSessionService.layer.pipe(
      Layer.provide(secretStoreLayer),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => execute(request)),
        ),
      ),
    ),
  };
}

it.effect("stores OpenAI API keys server-side and returns only an ephemeral credential", () => {
  const { execute, layer } = makeTestLayer();

  return Effect.gen(function* () {
    const voice = yield* VoiceSessionService.VoiceSessionService;
    assert.deepStrictEqual(yield* voice.getCredentialStatus, { configured: false });

    assert.deepStrictEqual(yield* voice.setCredential("  openai-user-key  "), {
      configured: true,
    });
    assert.deepStrictEqual(yield* voice.getCredentialStatus, { configured: true });

    const access = yield* voice.createSession("gpt-realtime-2.1-mini");
    assert.deepStrictEqual(access, {
      clientSecret: "ephemeral-secret",
      expiresAt: 1_800_000_000,
      realtimeUrl: "https://api.openai.com/v1/realtime/calls",
    });
    assert.equal(execute.mock.calls.length, 1);
    const request = execute.mock.calls[0]?.[0];
    assert.isDefined(request);
    assert.equal(request.headers.authorization, "Bearer openai-user-key");
    const body = (request.body as { readonly body?: Uint8Array }).body;
    assert.isDefined(body);
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(body)), {
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1-mini",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: true,
            },
          },
        },
      },
    });

    assert.deepStrictEqual(yield* voice.removeCredential, { configured: false });
    assert.deepStrictEqual(yield* voice.getCredentialStatus, { configured: false });
  }).pipe(Effect.provide(layer));
});

it.effect("maps OpenAI authentication failures without exposing the saved key", () => {
  const { layer } = makeTestLayer(() => new Response(null, { status: 401 }));

  return Effect.gen(function* () {
    const voice = yield* VoiceSessionService.VoiceSessionService;
    yield* voice.setCredential("openai-sensitive-key");
    const error = yield* Effect.flip(voice.createSession("gpt-realtime-2.1"));

    assert.equal(error.reason, "credential_invalid");
    assert.notInclude(error.message, "openai-sensitive-key");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps the Parallel key server-side and maps Search and Extract responses", () => {
  const { execute, layer } = makeTestLayer((request) => {
    if (request.url.endsWith("/v1/search")) {
      return Response.json({
        search_id: "search-1",
        session_id: "session-1",
        results: [
          {
            url: "https://example.com/news",
            title: "Current news",
            publish_date: "2026-07-16",
            excerpts: ["A relevant search excerpt."],
          },
        ],
      });
    }
    return Response.json({
      extract_id: "extract-1",
      session_id: "session-1",
      results: [
        {
          url: "https://example.com/news",
          title: "Current news",
          excerpts: ["The extracted evidence."],
        },
      ],
      errors: [],
    });
  });

  return Effect.gen(function* () {
    const voice = yield* VoiceSessionService.VoiceSessionService;
    assert.deepStrictEqual(yield* voice.getParallelCredentialStatus, { configured: false });
    assert.deepStrictEqual(yield* voice.setParallelCredential("  parallel-secret  "), {
      configured: true,
    });

    const search = yield* voice.searchWeb({
      objective: "Find the latest relevant news.",
      searchQueries: ["latest relevant news"],
    });
    assert.deepStrictEqual(search, {
      searchId: "search-1",
      sessionId: "session-1",
      results: [
        {
          url: "https://example.com/news",
          title: "Current news",
          publishDate: "2026-07-16",
          excerpts: ["A relevant search excerpt."],
        },
      ],
    });

    const extracted = yield* voice.extractWeb({
      urls: ["https://example.com/news"],
      objective: "Read the evidence needed to answer.",
      sessionId: search.sessionId,
    });
    assert.deepStrictEqual(extracted, {
      extractId: "extract-1",
      sessionId: "session-1",
      results: [
        {
          url: "https://example.com/news",
          title: "Current news",
          excerpts: ["The extracted evidence."],
        },
      ],
      errors: [],
    });

    assert.equal(execute.mock.calls.length, 2);
    for (const [request] of execute.mock.calls) {
      assert.equal(request.headers["x-api-key"], "parallel-secret");
      assert.notInclude(request.url, "parallel-secret");
    }
    const searchRequest = execute.mock.calls[0]?.[0];
    assert.isDefined(searchRequest);
    const searchBody = (searchRequest.body as { readonly body?: Uint8Array }).body;
    assert.isDefined(searchBody);
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(searchBody)), {
      objective: "Find the latest relevant news.",
      search_queries: ["latest relevant news"],
      mode: "basic",
      max_chars_total: 12_000,
      client_model: "gpt-realtime-2.1-mini",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("rejects invalid Parallel requests before making a network call", () => {
  const { execute, layer } = makeTestLayer();

  return Effect.gen(function* () {
    const voice = yield* VoiceSessionService.VoiceSessionService;
    yield* voice.setParallelCredential("parallel-secret");

    const searchError = yield* Effect.flip(
      voice.searchWeb({ objective: "Search", searchQueries: [] }),
    );
    assert.equal(searchError.reason, "invalid_web_tool_request");

    const extractError = yield* Effect.flip(
      voice.extractWeb({ urls: ["file:///private/data"], objective: "Read this" }),
    );
    assert.equal(extractError.reason, "invalid_web_tool_request");
    assert.equal(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});
