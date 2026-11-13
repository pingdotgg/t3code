import { LiveVoiceError, type CodexSettings } from "@t3tools/contracts";
import type { ProviderLiveVoice } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { ChildProcessSpawner } from "effect/process";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { withCodexAppServerClient } from "./CodexProvider.ts";

// A cancelled handshake must not leave an unhandled WebSocket error.
const webSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

const VoiceList = Schema.Struct({
  voices: Schema.Struct({
    v1: Schema.Array(Schema.String),
    v3: Schema.optionalKey(Schema.Array(Schema.String)),
    defaultV1: Schema.String,
  }),
});
const Claims = Schema.Struct({
  "https://api.openai.com/auth": Schema.optionalKey(
    Schema.Struct({
      chatgpt_account_id: Schema.optionalKey(Schema.String),
    }),
  ),
});

const decodeVoiceList = Schema.decodeUnknownEffect(VoiceList);
const decodeClaims = Schema.decodeEffect(Schema.fromJsonString(Claims));
const isLiveVoiceError = Schema.is(LiveVoiceError);
const encodeSession = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeCodexLiveVoice = Effect.fn("CodexLiveVoice.make")(function* <E, R>(
  resolve: Effect.Effect<
    {
      readonly config: CodexSettings;
      readonly environment: NodeJS.ProcessEnv;
      readonly subscriptionToken?: Redacted.Redacted<string>;
    },
    E,
    R
  >,
) {
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const context = yield* Effect.context<R>();
  const configuration = resolve.pipe(
    Effect.provide(context),
    Effect.mapError(() => new LiveVoiceError({ reason: "authentication" })),
  );
  const read = Effect.fn("CodexLiveVoice.read")(
    function* () {
      const { config, environment, subscriptionToken } = yield* configuration;
      const { client } = yield* withCodexAppServerClient({
        binaryPath: config.binaryPath,
        homePath: config.homePath,
        launchArgs: config.launchArgs,
        environment,
        cwd: config.homePath || ".",
      });
      let token: Redacted.Redacted<string>;
      if (subscriptionToken) {
        token = subscriptionToken;
      } else {
        const account = yield* client.request("account/read", { refreshToken: false });
        if (account.account?.type !== "chatgpt")
          return yield* new LiveVoiceError({ reason: "authentication" });
        const auth = yield* client.request("getAuthStatus", {
          includeToken: true,
          refreshToken: false,
        });
        if (auth.authMethod !== "chatgpt" || !auth.authToken)
          return yield* new LiveVoiceError({ reason: "unsupported" });
        token = Redacted.make(auth.authToken);
      }
      const raw = yield* client.raw.request("thread/realtime/listVoices", {});
      const list = yield* decodeVoiceList(raw);
      const voices = list.voices.v3?.length ? list.voices.v3 : list.voices.v1;
      const claims = subscriptionToken
        ? undefined
        : yield* decodeClaims(
            Buffer.from(Redacted.value(token).split(".")[1] ?? "", "base64url").toString(),
          );
      const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      return {
        token,
        accountId,
        voices,
        defaultVoice: list.voices.defaultV1,
        sharing: subscriptionToken !== undefined,
      };
    },
    Effect.scoped,
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.mapError((error) =>
      isLiveVoiceError(error) ? error : new LiveVoiceError({ reason: "unsupported" }),
    ),
  );
  return {
    options: read().pipe(Effect.map(({ voices, defaultVoice }) => ({ voices, defaultVoice }))),
    open: Effect.fn("CodexLiveVoice.open")(
      function* (input: Parameters<ProviderLiveVoice["open"]>[0]) {
        const auth = yield* read();
        if (!auth.voices.includes(input.voice))
          return yield* new LiveVoiceError({ reason: "unsupported" });
        const headers = {
          authorization: `Bearer ${Redacted.value(auth.token)}`,
          "OpenAI-Alpha": "quicksilver=v2",
          originator: "T3 Code",
          ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
        };
        const session = {
          model: "gpt-live-1-codex",
          instructions: "",
          audio: { output: { voice: input.voice } },
          delegation: { type: "client" },
          initial_items: input.context.map(({ role, text }) => ({
            type: "message",
            role,
            content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
          })),
        };
        // Native realtime RPCs start Codex turns outside T3 accounting; T3 must own delegation.
        // Preserve the selected connection's subscription credential route; never use API keys.
        let request = HttpClientRequest.post(
          auth.sharing
            ? "https://api.openai.com/v1/live"
            : "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
        ).pipe(HttpClientRequest.setHeaders(headers));
        if (auth.sharing) {
          const form = new FormData();
          form.set("sdp", input.sdp);
          form.set("session", yield* encodeSession(session));
          request = request.pipe(HttpClientRequest.bodyFormData(form));
        } else {
          request = request.pipe(HttpClientRequest.bodyJsonUnsafe({ sdp: input.sdp, session }));
        }
        const response = yield* http
          .execute(request)
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          );
        if (response.status < 200 || response.status >= 300)
          return yield* new LiveVoiceError({ reason: "connection", status: response.status });
        const sdp = yield* response.text;
        const location = response.headers.location;
        const callId = location?.split("/").filter(Boolean).at(-1);
        if (!callId || !/^[A-Za-z0-9_-]+$/.test(callId))
          return yield* new LiveVoiceError({ reason: "connection" });
        const socket = yield* Socket.makeWebSocket(`wss://api.openai.com/v1/live/${callId}`, {
          headers,
          openTimeout: "15 seconds",
        }).pipe(Effect.provide(webSocketConstructor));
        const writer = yield* socket.writer;
        const send = Effect.fn("CodexLiveVoice.send")((event: unknown) =>
          encodeEvent(event).pipe(
            Effect.flatMap((encoded) => writer.write(encoded)),
            Effect.mapError(() => new LiveVoiceError({ reason: "connection" })),
          ),
        );
        let connected = false;
        yield* Effect.addFinalizer(() =>
          connected
            ? send({ type: "session.close" }).pipe(Effect.timeout("1 second"), Effect.ignore)
            : Effect.void,
        );
        const { pull } = yield* socket.reader;
        connected = true;
        const events = Stream.fromPull(Effect.succeed(pull)).pipe(
          Stream.map((frame) =>
            typeof frame === "string" ? frame : new TextDecoder().decode(frame),
          ),
          Stream.mapError(() => new LiveVoiceError({ reason: "connection" })),
        );
        return { sdp, events, send };
      },
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        isLiveVoiceError(error) ? error : new LiveVoiceError({ reason: "connection" }),
      ),
    ),
  } satisfies ProviderLiveVoice;
});
