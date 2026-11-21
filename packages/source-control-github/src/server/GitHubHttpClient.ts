import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";

import { GH_PROCESS_CONCURRENCY } from "./GitHubCredentials.ts";

const makeClient = Effect.fn("GitHubHttpClient.makeClient")(function* (
  fallback: HttpClient.HttpClient,
  host: SourceControlHost.SourceControlHost["Service"],
  cwd: string,
) {
  const socketPath = yield* host.process
    .run({
      operation: "GitHubHttpClient.config",
      command: "gh",
      args: ["config", "get", "http_unix_socket"],
      cwd,
      env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
      timeoutMs: 10_000,
      concurrency: GH_PROCESS_CONCURRENCY,
    })
    .pipe(
      Effect.map((output) => output.stdout.trim()),
      Effect.orElseSucceed(() => ""),
    );
  if (socketPath === "") return fallback;

  const agent = yield* NodeHttpClient.makeAgent({ socketPath, keepAlive: false });
  const client = yield* NodeHttpClient.makeNodeHttp.pipe(
    Effect.provideService(NodeHttpClient.HttpAgent, agent),
  );
  return HttpClient.make((initialRequest, initialUrl) =>
    Effect.gen(function* () {
      let request = initialRequest;
      let originalUrl = initialUrl;
      for (let redirects = 0; ; redirects++) {
        const url = new URL(originalUrl);
        // gh sends plain HTTP over the socket while preserving the API authority.
        url.protocol = "http:";
        const response = yield* client.execute(
          request.pipe(
            HttpClientRequest.setUrl(url),
            HttpClientRequest.setHeader("host", originalUrl.host),
          ),
        );
        const location = response.headers.location;
        if (![301, 302, 303, 307, 308].includes(response.status) || !location || redirects >= 10) {
          return response;
        }
        const destination = new URL(location, originalUrl);
        if (destination.origin !== originalUrl.origin) {
          if (request.body._tag !== "Empty") return response;
          request = request.pipe(
            HttpClientRequest.removeHeader("authorization"),
            HttpClientRequest.removeHeader("proxy-authorization"),
            HttpClientRequest.removeHeader("cookie"),
          );
        }
        if (
          ((response.status === 301 || response.status === 302) && request.method === "POST") ||
          (response.status === 303 && request.method !== "GET" && request.method !== "HEAD")
        ) {
          request = request.pipe(
            HttpClientRequest.setMethod("GET"),
            HttpClientRequest.setBody(HttpBody.empty),
          );
        }
        yield* Effect.scoped(Effect.asVoid(Stream.toPull(response.stream)));
        request = HttpClientRequest.setUrl(request, destination);
        originalUrl = destination;
      }
    }),
  );
});

export const layer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const fallback = yield* HttpClient.HttpClient;
    const host = yield* SourceControlHost.SourceControlHost;
    const cwd = yield* HostProcess.WorkingDirectory;
    const scope = yield* Effect.scope;
    // Asking gh on the first request keeps its process start off the server's startup path.
    const client = yield* Effect.cached(makeClient(fallback, host, cwd).pipe(Scope.provide(scope)));
    return HttpClient.makeWith(
      (request: Effect.Effect<HttpClientRequest.HttpClientRequest>) =>
        Effect.flatMap(client, (resolved) => Effect.flatMap(request, resolved.execute)),
      Effect.succeed,
    );
  }),
);
