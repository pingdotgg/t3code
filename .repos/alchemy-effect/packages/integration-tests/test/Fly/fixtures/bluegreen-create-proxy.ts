import { createServer } from "node:http";
import { Credentials } from "@distilled.cloud/fly-io/Credentials";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";

export const dropCompletedCreate = Effect.fn(function* (appName: string) {
  const resolveCredentials = yield* Credentials;
  const config = yield* resolveCredentials;
  const client = yield* HttpClient.HttpClient;
  const forwarded = yield* Ref.make(0);
  const completedStatus = yield* Ref.make<number | undefined>(undefined);
  const route = `/v1/apps/${appName}/machines`;
  const authorization = `Bearer ${Redacted.value(config.apiKey)}`;
  const raw = yield* Effect.sync(() => createServer());
  const server = yield* NodeHttpServer.make(() => raw, {
    host: "127.0.0.1",
    port: 0,
    gracefulShutdownTimeout: "1 second",
  });
  if (server.address._tag !== "InetAddressV4") {
    return yield* Effect.fail(new Error("Probe proxy must bind IPv4 loopback"));
  }
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (
        request.method !== "POST" ||
        request.url !== route ||
        request.headers.authorization !== authorization
      ) {
        yield* Effect.sync(() => NodeHttpServerRequest.toIncomingMessage(request).socket.destroy());
        return HttpServerResponse.empty();
      }
      const body = yield* request.text;
      yield* Ref.update(forwarded, (count) => count + 1);
      const response = yield* client.execute(
        HttpClientRequest.post(`${config.apiBaseUrl}${route}`).pipe(
          HttpClientRequest.setHeader("authorization", authorization),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      );
      const actualBody = yield* response.text;
      yield* Ref.set(completedStatus, response.status);
      if (response.status >= 200 && response.status < 300) {
        // Drop the actual completed response, not a synthesized API failure.
        yield* Effect.sync(() => NodeHttpServerRequest.toIncomingMessage(request).socket.destroy());
        return HttpServerResponse.empty();
      }
      return HttpServerResponse.text(actualBody, {
        status: response.status,
        contentType: response.headers["content-type"] ?? "application/json",
      });
    }),
  );
  return {
    credentials: Effect.succeed({
      ...config,
      apiBaseUrl: `http://127.0.0.1:${server.address.port}`,
    }),
    forwarded: Ref.get(forwarded),
    completedStatus: Ref.get(completedStatus),
  };
});
