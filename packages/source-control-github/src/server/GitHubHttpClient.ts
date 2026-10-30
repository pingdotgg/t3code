import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/http";

import { GH_PROCESS_CONCURRENCY } from "./GitHubCredentials.ts";

export const layer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const fallback = yield* HttpClient.HttpClient;
    const host = yield* SourceControlHost.SourceControlHost;
    const cwd = yield* HostProcess.WorkingDirectory;
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
    return HttpClient.mapRequest(client, (request) => {
      const url = new URL(request.url);
      // gh's Unix transport sends plain HTTP even for HTTPS URLs, keeping the original Host.
      const authority = url.host;
      url.protocol = "http:";
      return request.pipe(
        HttpClientRequest.setUrl(url),
        HttpClientRequest.setHeader("host", authority),
      );
    });
  }),
);
