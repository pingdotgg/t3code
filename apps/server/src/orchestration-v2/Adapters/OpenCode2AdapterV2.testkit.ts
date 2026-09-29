/**
 * Replays an OpenCode 2 transcript at the HTTP boundary: the real
 * `@opencode/client` and the adapter's event reader run against an
 * `HttpClient` that answers from the transcript, so request encoding and
 * response decoding are both exercised.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";

import { ServerConfig } from "../../config.ts";
import * as OpenCode2Client from "../../provider/opencode2/OpenCode2Client.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import { OPENCODE_PROVIDER } from "./OpenCodeAdapterV2.ts";
import {
  OpenCodeReplayController,
  OpenCodeReplayTranscriptDecodeError,
} from "./OpenCodeAdapterV2.testkit.ts";
import { makeOpenCode2Adapter } from "./OpenCode2AdapterV2.ts";

export const OPENCODE2_HTTP_PROTOCOL = "opencode2-http.sse" as const;
const BASE_URL = "http://opencode2.replay";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const OpenCode2ReplayTranscript = Schema.Struct({
  provider: Schema.Literal(OPENCODE_PROVIDER),
  protocol: Schema.Literal(OPENCODE2_HTTP_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type OpenCode2ReplayTranscript = typeof OpenCode2ReplayTranscript.Type;
const decodeOpenCode2ReplayTranscript = Schema.decodeUnknownEffect(OpenCode2ReplayTranscript);

/** Names a request the way the recordings do: the client operation and its JSON input. */
const operationOf = (
  method: string,
  path: string,
  query: Record<string, unknown>,
  body: unknown,
) => {
  const session = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path);
  if (method === "GET" && path === "/api/event") return { type: "event.subscribe" };
  if (method === "GET" && path === "/api/model") return { type: "model.list", input: query };
  if (method === "POST" && path === "/api/session") return { type: "session.create", input: body };
  if (session !== null) {
    const [, sessionID, rest = ""] = session;
    const input = { sessionID, ...query, ...(body === undefined ? {} : (body as object)) };
    if (method === "GET" && rest === "") return { type: "session.get", input };
    if (method === "POST" && rest === "/prompt") return { type: "session.prompt", input };
    if (method === "POST" && rest === "/interrupt") return { type: "session.interrupt", input };
    if (method === "GET" && rest === "/message") return { type: "message.list", input };
  }
  return { type: `${method} ${path}`, input: { ...query, body } };
};

/** An `HttpClient` that answers every request from the transcript. */
const replayHttpClient = (controller: OpenCodeReplayController) =>
  HttpClient.make((request, url) =>
    Effect.tryPromise({
      try: async () => {
        const raw =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : undefined;
        const query = UrlParams.toRecord(UrlParams.fromInput(url.searchParams));
        const operation = operationOf(
          request.method,
          url.pathname,
          query,
          raw === undefined ? undefined : decodeJson(raw),
        );
        await controller.expectOutbound(operation);
        if (operation.type === "event.subscribe") {
          const encoder = new TextEncoder();
          const frames = controller.events()[Symbol.asyncIterator]();
          const body = new ReadableStream<Uint8Array>({
            async pull(stream) {
              const next = await frames.next();
              if (next.done === true) stream.close();
              else stream.enqueue(encoder.encode(`data: ${encodeJson(next.value)}\n\n`));
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        // Recorded responses are the raw HTTP bodies; `null` is an empty 204.
        const body = await controller.response(operation.type);
        return body === null
          ? new Response(null, { status: 204 })
          : new Response(encodeJson(body), { headers: { "content-type": "application/json" } });
      },
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
  );

function makeRegistryLayer(transcript: OpenCode2ReplayTranscript) {
  const controller = new OpenCodeReplayController(transcript);
  const serverConfigLayer = Layer.effect(
    ServerConfig,
    makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
      const opencode = yield* OpenCode2Client.make.pipe(
        Effect.provideService(HttpClient.HttpClient, replayHttpClient(controller)),
      );
      const connection = {
        ...(yield* opencode.connect({ baseUrl: BASE_URL, password: "replay" })),
        url: BASE_URL,
        version: transcript.version,
        external: true,
      };
      return makeLayer([
        makeOpenCode2Adapter({
          instanceId: ProviderInstanceId.make("opencode"),
          server: { withConnection: (use) => use(connection) },
          idAllocator: yield* IdAllocatorV2,
          serverConfig: yield* ServerConfig,
        }),
      ]);
    }),
  ).pipe(Layer.provide(Layer.mergeAll(serverConfigLayer, idAllocatorLayer)));
}

export const OpenCode2OrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  OpenCode2ReplayTranscript,
  OpenCodeReplayTranscriptDecodeError
> = {
  driver: OPENCODE_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeOpenCode2ReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeReplayTranscriptDecodeError({
            driver: transcript.provider,
            protocol: transcript.protocol,
            scenario: transcript.scenario,
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: makeRegistryLayer,
};
