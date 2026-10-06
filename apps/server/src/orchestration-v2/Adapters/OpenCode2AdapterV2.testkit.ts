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
  ProviderSessionId,
  ThreadId,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";

import * as ServerConfig from "../../config.ts";
import * as OpenCode2Client from "../../provider/opencode2/OpenCode2Client.ts";
import * as OpenCode2Server from "../../provider/opencode2/OpenCode2Server.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { ProviderReplayGate } from "../testkit/ProviderReplayGate.testkit.ts";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import { OPENCODE_PROVIDER } from "./OpenCodeAdapterV2.ts";
import {
  OpenCodeReplayController,
  OpenCodeReplayTranscriptDecodeError,
} from "./OpenCodeAdapterV2.testkit.ts";
import * as OpenCode2AdapterV2 from "./OpenCode2AdapterV2.ts";

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
  if (method === "GET" && path === "/api/agent") return { type: "agent.list", input: query };
  if (method === "POST" && path === "/api/session") return { type: "session.create", input: body };
  if (method === "GET" && path === "/api/session/active") return { type: "session.active" };
  if (method === "GET" && path === "/api/command") return { type: "command.list", input: query };
  const mcp = /^\/api\/experimental\/mcp\/([^/]+)$/.exec(path);
  if (mcp !== null && method === "PUT") {
    return { type: "mcp.add", input: { server: mcp[1], ...query, ...(body as object) } };
  }
  if (mcp !== null && method === "DELETE") {
    return { type: "mcp.remove", input: { server: mcp[1], ...query } };
  }
  const entry = /^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/.exec(
    path,
  );
  if (entry !== null && method === "PUT") {
    return {
      type: "session.instructions.entry.put",
      input: { sessionID: entry[1], key: entry[2], ...(body as object) },
    };
  }
  if (method === "GET" && path === "/api/skill") return { type: "skill.list", input: query };
  if (session !== null) {
    const [, sessionID, rest = ""] = session;
    // The client sends absent optional fields as `null`; recordings omit them.
    const fields = Object.entries((body ?? {}) as Record<string, unknown>).filter(
      ([, value]) => value !== null,
    );
    const input = { sessionID, ...query, ...Object.fromEntries(fields) };
    if (method === "GET" && rest === "") return { type: "session.get", input };
    if (method === "DELETE" && rest === "") return { type: "session.remove", input };
    if (method === "PATCH" && rest === "") return { type: "session.update", input };
    if (method === "POST" && rest === "/prompt") return { type: "session.prompt", input };
    if (method === "POST" && rest === "/command") return { type: "session.command", input };
    if (method === "POST" && rest === "/compact") return { type: "session.compact", input };
    if (method === "POST" && rest === "/interrupt") return { type: "session.interrupt", input };
    if (method === "POST" && rest === "/model") return { type: "session.switchModel", input };
    if (method === "POST" && rest === "/agent") return { type: "session.switchAgent", input };
    if (method === "POST" && rest === "/move") return { type: "session.move", input };
    if (method === "POST" && rest === "/synthetic") return { type: "session.synthetic", input };
    if (method === "POST" && rest === "/fork") return { type: "session.fork", input };
    if (method === "POST" && rest === "/revert/stage") {
      return { type: "session.revert.stage", input };
    }
    if (method === "POST" && rest === "/revert/commit") {
      return { type: "session.revert.commit", input };
    }
    if (method === "DELETE" && rest === "/revert") return { type: "session.revert.clear", input };
    const inbox = /^\/inbox\/([^/]+)$/.exec(rest);
    if (method === "DELETE" && inbox !== null) {
      // T3's steer ids carry `:`, which the path encodes.
      const inboxID = decodeURIComponent(inbox[1] ?? "");
      return { type: "session.inbox.cancel", input: { ...input, inboxID } };
    }
    if (method === "GET" && rest === "/message") return { type: "message.list", input };
    if (method === "GET" && rest === "/permission") return { type: "permission.list", input };
    if (method === "GET" && rest === "/form") return { type: "session.form.list", input };
    const form = /^\/form\/([^/]+)(\/reply)?$/.exec(rest);
    if (form !== null) {
      const formInput = { ...input, formID: form[1] };
      if (method === "POST" && form[2] !== undefined) {
        return { type: "session.form.reply", input: formInput };
      }
      if (method === "DELETE") return { type: "session.form.cancel", input: formInput };
    }
    const permission = /^\/permission\/([^/]+)\/reply$/.exec(rest);
    if (method === "POST" && permission !== null) {
      return { type: "permission.reply", input: { ...input, requestID: permission[1] } };
    }
  }
  return { type: `${method} ${path}`, input: { ...query, body } };
};

/**
 * An `HttpClient` that answers every request from the transcript. A successful
 * `runtime_exit` ends the event stream: the server has stopped. When entries
 * follow it, the server was restarted and the next `event.subscribe` opens its
 * new stream; a transcript that ends there stays down, so every later request
 * fails to connect as it would against a stopped server.
 */
const replayHttpClient = (
  controller: OpenCodeReplayController,
  replayGate: ProviderReplayGate | undefined,
) =>
  HttpClient.make((request, url) =>
    Effect.tryPromise({
      try: async () => {
        if (controller.exited && controller.finished) {
          throw new Error("The replayed OpenCode server has exited.");
        }
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
        // The event stream and requests are separate connections: a request
        // is matched only once what was recorded before it was delivered.
        if (operation.type !== "event.subscribe") await controller.untilInboundDelivered();
        await controller.expectOutbound(operation);
        if (operation.type === "event.subscribe") {
          controller.exited = false;
          const encoder = new TextEncoder();
          const events = controller.events(undefined, replayGate?.beforeEmit);
          const frames = events[Symbol.asyncIterator]();
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
        // `{ status, body }` replays an error status and `"<hang>"` never answers.
        const body = await controller.response(operation.type);
        if (body === "<hang>") return new Promise<Response>(() => {});
        if (typeof body === "object" && body !== null && "status" in body && "body" in body) {
          return new Response(encodeJson(body.body), {
            status: Number(body.status),
            headers: { "content-type": "application/json" },
          });
        }
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

/**
 * An OpenCode 2 server that answers from `transcript`, checking at scope close
 * that the transcript ran out.
 */
export const replayServer = (
  transcript: ProviderReplayTranscript,
  options?: {
    readonly external?: boolean;
    readonly replayGate?: ProviderReplayGate;
    /** Counts the connections currently lent out, as the server owner's borrowers. */
    readonly borrowers?: { current: number };
  },
) =>
  Effect.gen(function* () {
    const controller = new OpenCodeReplayController(transcript);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        options?.replayGate?.releaseAll();
        controller.assertComplete();
      }),
    );
    const opencode = yield* OpenCode2Client.make.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        replayHttpClient(controller, options?.replayGate),
      ),
    );
    const connection = {
      ...(yield* opencode.connect({ baseUrl: BASE_URL, password: "replay" })),
      url: BASE_URL,
      version: transcript.version,
      external: options?.external ?? false,
    };
    const borrowers = options?.borrowers;
    return OpenCode2Server.OpenCode2Server.of({
      withConnection: (use) =>
        borrowers === undefined
          ? use(connection)
          : Effect.acquireUseRelease(
              Effect.sync(() => {
                borrowers.current += 1;
              }),
              () => use(connection),
              () =>
                Effect.sync(() => {
                  borrowers.current -= 1;
                }),
            ),
    });
  });

/** The 2.x adapter over a replayed server. */
const makeReplayAdapter = (
  transcript: ProviderReplayTranscript,
  options?: {
    readonly external?: boolean;
    readonly replayGate?: ProviderReplayGate;
    /** Counts the connections currently lent out, as the server owner's borrowers. */
    readonly borrowers?: { current: number };
  },
) =>
  Effect.gen(function* () {
    const server = yield* replayServer(transcript, options);
    return yield* OpenCode2AdapterV2.make(ProviderInstanceId.make("opencode")).pipe(
      Effect.provideService(OpenCode2Server.OpenCode2Server, server),
    );
  });

const layerReplayServerConfig = (scenario: string) =>
  Layer.effect(ServerConfig.ServerConfig, makeReplayServerConfig(scenario).pipe(Effect.orDie)).pipe(
    Layer.provide(NodeServices.layer),
  );

function layerRegistry(
  transcript: OpenCode2ReplayTranscript,
  options?: { readonly replayGate?: ProviderReplayGate },
) {
  return Layer.unwrap(
    makeReplayAdapter(transcript, { external: true, ...options }).pipe(
      Effect.map((adapter) => ProviderAdapterRegistry.layerFromAdapters([adapter])),
    ),
  ).pipe(
    Layer.provide(Layer.mergeAll(layerReplayServerConfig(transcript.scenario), IdAllocator.layer)),
  );
}

/**
 * An open 2.x session runtime whose server answers from `entries`, for
 * adapter-level tests of failures a real server cannot produce on demand.
 */
export const openCode2ReplayRuntime = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: { readonly external?: boolean; readonly borrowers?: { current: number } },
) =>
  Effect.gen(function* () {
    const adapter = yield* makeReplayAdapter(
      {
        provider: OPENCODE_PROVIDER,
        protocol: OPENCODE2_HTTP_PROTOCOL,
        version: "2.0.18",
        scenario: "opencode2_adapter",
        entries,
      },
      options,
    );
    return yield* adapter.openSession({
      threadId: ThreadId.make("thread:opencode2-adapter"),
      providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opencode/big-pickle",
      },
      // Opened where the adapter tests' threads run, as T3 opens a session for its first thread.
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/work/opencode2",
      },
    });
  }).pipe(
    Effect.provide(Layer.mergeAll(layerReplayServerConfig("opencode2_adapter"), IdAllocator.layer)),
  );

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
  makeProviderAdapterRegistryLayer: layerRegistry,
};
