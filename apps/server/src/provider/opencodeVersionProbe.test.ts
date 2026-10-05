import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";
import {
  classifyOpenCodeCliVersion,
  makeOpenCodeRuntimeProbe,
  probeOpenCodeRuntime,
} from "./opencodeVersionProbe.ts";
import {
  OPENCODE_1_RESPONSES,
  OPENCODE_2_RESPONSES,
  replayOpenCodeServer,
} from "./testFixtures/opencodeProbeResponses.ts";

const noBinary = {
  runOpenCodeCommand: () => Effect.die("A configured server must not run the local binary"),
} as unknown as OpenCodeRuntime.OpenCodeRuntimeShape;

const probeServer = (serverUrl: string, serverPassword: string, http: HttpClient.HttpClient) =>
  probeOpenCodeRuntime({ binaryPath: "opencode", serverUrl, serverPassword }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, noBinary),
  );
const SERVER_URL = "http://127.0.0.1:4096/";

describe("OpenCode version probe", () => {
  it("classifies the recorded `opencode --version` output of both versions", () => {
    assert.deepStrictEqual(classifyOpenCodeCliVersion("1.18.32\n"), {
      generation: "v1",
      version: "1.18.32",
    });
    assert.deepStrictEqual(classifyOpenCodeCliVersion("opencode v2.0.18\n"), {
      generation: "v2",
      version: "2.0.18",
    });
    assert.isUndefined(classifyOpenCodeCliVersion("opencode dev build\n"));
  });

  it.effect("finds 2.x at /api/info without falling through to its HTML /global/health", () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      const probed = yield* probeServer(
        SERVER_URL,
        "pw",
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "pw", paths),
      );
      assert.deepStrictEqual(probed, { generation: "v2", version: "2.0.18" });
      assert.deepStrictEqual(paths, ["/api/info"]);
    }),
  );

  it.effect("skips the HTML 1.x serves at /api/info and finds it at /global/health", () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      const probed = yield* probeServer(
        SERVER_URL,
        "pw",
        replayOpenCodeServer(OPENCODE_1_RESPONSES, "pw", paths),
      );
      assert.deepStrictEqual(probed, { generation: "v1", version: "1.18.32" });
      assert.deepStrictEqual(paths, ["/api/info", "/global/health"]);
    }),
  );

  it.effect("keeps a server URL's path prefix and query when probing", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      const replay = replayOpenCodeServer(OPENCODE_1_RESPONSES, "pw");
      // A reverse proxy mounting OpenCode under /opencode, reached with a routing query.
      const proxied = HttpClient.make((request, url) => {
        urls.push(url.href);
        return replay.execute(
          HttpClientRequest.setUrl(
            request,
            `http://127.0.0.1:4096${url.pathname.replace(/^\/opencode/, "")}`,
          ),
        );
      });
      const probed = yield* probeServer("http://proxy:8080/opencode/?route=oc", "pw", proxied);
      assert.strictEqual(probed.generation, "v1");
      assert.deepStrictEqual(urls, [
        "http://proxy:8080/opencode/api/info?route=oc",
        "http://proxy:8080/opencode/global/health?route=oc",
      ]);
    }),
  );

  it.effect("reports a rejected password instead of guessing a version", () =>
    Effect.gen(function* () {
      for (const responses of [OPENCODE_1_RESPONSES, OPENCODE_2_RESPONSES]) {
        const paths: Array<string> = [];
        const error = yield* Effect.flip(
          probeServer(SERVER_URL, "wrong", replayOpenCodeServer(responses, "pw", paths)),
        );
        assert.match(error.detail, /401 Unauthorized/);
        assert.deepStrictEqual(paths, ["/api/info"]);
      }
    }),
  );

  it.effect("sends a non-ASCII password as UTF-8, as both versions expect", () =>
    Effect.gen(function* () {
      for (const [responses, password, generation] of [
        [OPENCODE_1_RESPONSES, "pässwörd", "v1"],
        [OPENCODE_2_RESPONSES, "pass€word", "v2"],
      ] as const) {
        const probed = yield* probeServer(
          SERVER_URL,
          password,
          replayOpenCodeServer(responses, password),
        );
        assert.strictEqual(probed.generation, generation);
      }
    }),
  );

  it.effect("does not take other JSON at /api/info for OpenCode 2", () =>
    Effect.gen(function* () {
      const impostor = {
        ...OPENCODE_1_RESPONSES,
        "/api/info": { status: 200, contentType: "application/json", body: '{"version":"3.4.1"}' },
        "/global/health": OPENCODE_1_RESPONSES["/api/info"],
      };
      const error = yield* Effect.flip(
        probeServer(SERVER_URL, "pw", replayOpenCodeServer(impostor, "pw")),
      );
      assert.match(error.detail, /did not identify itself as OpenCode/);
    }),
  );

  it.effect("never puts the configured URL or its credentials in an error detail", () =>
    Effect.gen(function* () {
      const secret = "userinfo-secret";
      const unreachable = HttpClient.make((request) =>
        Effect.die(`should not be reached for ${request.url}`),
      );
      // A fetch failure that echoes the full request URL, as Node's does.
      const refused = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: `connect ECONNREFUSED ${request.url}`,
            }),
          }),
        ),
      );
      for (const [serverUrl, http] of [
        [`127.0.0.1:4096?token=${secret}`, unreachable],
        [`localhost:4096/${secret}`, unreachable],
        [`http://user:${secret}@10.0.0.1:4096/?token=${secret}`, refused],
      ] as const) {
        const error = yield* Effect.flip(probeServer(serverUrl, secret, http));
        assert.notInclude(error.detail, secret, serverUrl);
        assert.notInclude(error.detail, "10.0.0.1", serverUrl);
      }
    }),
  );

  it.effect("remembers a probed runtime but never a failure", () =>
    Effect.gen(function* () {
      const outputs = ["", "opencode v2.0.18\n", "1.18.32\n"];
      let calls = 0;
      const runtime = {
        runOpenCodeCommand: () => {
          const stdout = outputs[calls++];
          return stdout
            ? Effect.succeed({ stdout, stderr: "", code: 0 })
            : Effect.fail(
                new OpenCodeRuntime.OpenCodeRuntimeError({ operation: "spawn", detail: "ENOENT" }),
              );
        },
      } as unknown as OpenCodeRuntime.OpenCodeRuntimeShape;
      const probe = yield* makeOpenCodeRuntimeProbe(
        probeOpenCodeRuntime({ binaryPath: "opencode", serverUrl: "", serverPassword: "" }).pipe(
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("A local binary must not be probed over HTTP")),
          ),
        ),
      );

      yield* Effect.flip(probe.get);
      assert.isTrue((yield* probe.lastSuccess)._tag === "None");
      assert.strictEqual((yield* probe.get).generation, "v2");
      assert.strictEqual((yield* probe.get).generation, "v2");
      assert.strictEqual(calls, 2);
      // A status refresh re-probes, so an in-place downgrade or upgrade re-routes.
      assert.strictEqual((yield* probe.refresh).generation, "v1");
      assert.strictEqual((yield* probe.get).generation, "v1");
      assert.strictEqual(calls, 3);
    }),
  );
});
