// @effect-diagnostics nodeBuiltinImport:off - A server-owned loopback bridge keeps OAuth recovery at the HTTP boundary.
import * as NodeHttp from "node:http";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/http";
import { type ProviderInstanceId, type ProviderSetupError } from "@t3tools/contracts";
import { makeCodexChatGptAuth, type CodexChatGptCredentials } from "./CodexChatGptAuth.ts";

const ExpiredToken = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("token_expired") }),
});
const decodeExpiredToken = Schema.decodeUnknownOption(Schema.fromJsonString(ExpiredToken));
const droppedHeaders = new Set([
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "cookie",
  "set-cookie",
]);
const forwardHeaders = (headers: Readonly<Record<string, string | undefined>>, decoded = false) => {
  const connectionHeaders = new Set(headers.connection?.toLowerCase().split(/\s*,\s*/u));
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) =>
        value !== undefined &&
        !droppedHeaders.has(name) &&
        !connectionHeaders.has(name) &&
        !(decoded && name === "content-encoding"),
    ),
  );
};

export const make = Effect.fn("CodexManagedResponses.make")(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const random = yield* SecureRandom.SecureRandom;
  const services =
    yield* Effect.context<Effect.Services<ReturnType<typeof makeCodexChatGptAuth>>>();
  const renewals = yield* FiberSet.make<CodexChatGptCredentials, ProviderSetupError>();
  // A spent refresh token must be saved even if Codex disconnects during the exchange.
  yield* Effect.addFinalizer(() => FiberSet.awaitEmpty(renewals));
  const grants = new Map<
    string,
    {
      instanceId: ProviderInstanceId;
      profileKey: string;
      auth: Effect.Success<ReturnType<typeof makeCodexChatGptAuth>>;
    }
  >();
  const register = Effect.fn("CodexManagedResponses.register")(function* (options: {
    readonly instanceId: ProviderInstanceId;
    readonly profileKey: string;
  }) {
    for (const [token, grant] of grants) {
      if (grant.instanceId === options.instanceId && grant.profileKey === options.profileKey) {
        yield* grant.auth.access;
        return token;
      }
    }
    const auth = yield* makeCodexChatGptAuth({
      instanceId: options.instanceId,
      expectedProfileKey: options.profileKey,
    });
    yield* auth.access;
    for (const [token, grant] of grants) {
      if (grant.instanceId === options.instanceId) grants.delete(token);
    }
    const token = Hex.encode(yield* random.randomBytes(32));
    grants.set(token, { ...options, auth });
    return token;
  }, Effect.provideContext(services));
  const forward = Effect.fn("CodexManagedResponses.forward")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const grant = grants.get(request.headers.authorization?.replace(/^Bearer /u, "") ?? "");
    if (!grant) return HttpServerResponse.empty({ status: 401 });
    const path = request.url.split("?", 1)[0];
    const inference =
      request.method === "POST" &&
      ["/v1/responses", "/v1/responses/compact", "/v1/responses/input_tokens"].includes(path!);
    if (!inference && !(request.method === "GET" && path === "/v1/models"))
      return HttpServerResponse.empty({ status: 404 });
    // Replay only the request body; successful SSE responses continue streaming with backpressure.
    const body = inference ? new Uint8Array(yield* request.arrayBuffer) : undefined;
    const access = yield* FiberSet.run(renewals, grant.auth.access);
    let credentials = yield* Fiber.join(access);
    const send = () =>
      http.execute(
        HttpClientRequest.make(inference ? "POST" : "GET")(
          `https://api.openai.com${request.url}`,
        ).pipe(
          HttpClientRequest.setHeaders(forwardHeaders(request.headers)),
          HttpClientRequest.bearerToken(credentials.accessToken),
          body === undefined
            ? (self) => self
            : HttpClientRequest.bodyUint8Array(body, request.headers["content-type"]),
        ),
      );
    let response = yield* send();
    if (inference && response.status === 401) {
      const rejected = yield* response.text;
      if (decodeExpiredToken(rejected)._tag === "Some") {
        const renewal = yield* FiberSet.run(renewals, grant.auth.renew(credentials.accessToken));
        const renewed = yield* Fiber.join(renewal).pipe(Effect.result);
        if (renewed._tag === "Success") {
          credentials = renewed.success;
          response = yield* send();
        } else {
          return HttpServerResponse.text(rejected, {
            status: 401,
            headers: forwardHeaders(response.headers, true),
            contentType: "application/json",
          });
        }
      } else {
        return HttpServerResponse.text(rejected, {
          status: 401,
          headers: forwardHeaders(response.headers, true),
          contentType: "application/json",
        });
      }
    }
    return HttpServerResponse.stream(response.stream, {
      status: response.status,
      headers: forwardHeaders(response.headers, true),
      ...(response.headers["content-type"]
        ? { contentType: response.headers["content-type"] }
        : {}),
    });
  });
  const server = yield* NodeHttpServer.make(NodeHttp.createServer, { host: "127.0.0.1", port: 0 });
  yield* server.serve(
    Effect.flatMap(HttpServerRequest.HttpServerRequest, forward).pipe(
      Effect.catchTags({
        ProviderSetupError: (error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                error: { code: "t3_managed_auth", message: error.detail },
              },
              { status: 401 },
            ),
          ),
      }),
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 502 })),
    ),
  );
  if (server.address._tag === "UnixPathAddress")
    return yield* Effect.die("Expected loopback TCP listener");
  return { baseUrl: `http://127.0.0.1:${server.address.port}/v1`, register };
});
