import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { OllamaSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import { OllamaDriver, normalizeOllamaEndpoint } from "./StandaloneDriver.ts";

const decodeOllamaSettings = Schema.decodeSync(OllamaSettings);

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-standalone-driver-config-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(layerDeps),
);

describe("normalizeOllamaEndpoint", () => {
  it("preserves Ollama's default port 11434 for bare hosts without a scheme or port", () => {
    expect(normalizeOllamaEndpoint("127.0.0.1")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaEndpoint("localhost")).toBe("http://localhost:11434");
  });

  it("leaves explicitly supplied schemes and ports intact", () => {
    expect(normalizeOllamaEndpoint("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeOllamaEndpoint("http://127.0.0.1")).toBe("http://127.0.0.1");
    expect(normalizeOllamaEndpoint("https://ollama.example.com")).toBe(
      "https://ollama.example.com",
    );
  });
});

it.layer(layerTest)("OllamaDriver", (it) => {
  it.effect("probes port 11434 when OLLAMA_HOST is a bare host without scheme or port", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestedUrls: Array<string> = [];
        const httpClient = HttpClient.make((request) => {
          requestedUrls.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response('{"version":"0.6.0"}', { status: 200 }),
            ),
          );
        });
        const spawner = ChildProcessSpawner.make(() =>
          Effect.die(new Error("CLI fallback should not run when HTTP probe succeeds")),
        );

        const instance = yield* OllamaDriver.create({
          instanceId: ProviderInstanceId.make("ollama"),
          displayName: "Ollama",
          environment: [
            {
              name: "OLLAMA_HOST",
              value: "127.0.0.1",
              sensitive: false,
            },
          ],
          enabled: true,
          config: decodeOllamaSettings({ enabled: true }),
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(requestedUrls).toEqual(["http://127.0.0.1:11434/api/version"]);
        expect(snapshot.installed).toBe(true);
        expect(snapshot.auth.status).toBe("authenticated");
      }),
    ),
  );
});
