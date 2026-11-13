import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import * as OriginCli from "./OriginCli.ts";

const http = vi.hoisted(() => ({
  requests: [] as Array<URL>,
  respond: (_url: URL): Response => Response.json({}),
}));

vi.mock("@effect/platform-node/NodeHttpClient", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const { HttpClient, HttpClientResponse } = await import("effect/http");
  return {
    layerNodeHttpOptions: () =>
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const url = new URL(request.url);
            http.requests.push(url);
            return HttpClientResponse.fromWeb(request, http.respond(url));
          }),
        ),
      ),
  };
});

const unexpected = () => Effect.die("unexpected host call");
const host = SourceControlHost.SourceControlHost.of({
  settings: {
    get: Effect.die("unexpected settings read"),
    getWithSecrets: unexpected,
    update: unexpected,
  },
  process: {
    run: (input) =>
      input.args.join(" ") === "auth token"
        ? Effect.succeed({
            exitCode: 0,
            stdout: "session-token",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          } as never)
        : unexpected(),
  },
  git: new Proxy({}, { get: () => unexpected }) as never,
});

const setup = (respond: (url: URL) => Response) => {
  http.requests = [];
  http.respond = respond;
};

const namespace = (slug: string, type: string) => ({ namespace: { slug, type } });

describe("personalNamespace", () => {
  it.effect("finds the personal namespace on a later page", () =>
    Effect.gen(function* () {
      setup((url) =>
        url.searchParams.get("pageToken") === "page-2"
          ? Response.json({ namespaces: [namespace("zz-personal", "user")] })
          : Response.json({
              namespaces: Array.from({ length: 30 }, (_, i) => namespace(`team-${i}`, "team")),
              nextPageToken: "page-2",
            }),
      );
      const cli = yield* OriginCli.OriginCli;
      assert.strictEqual(yield* cli.personalNamespace("/repo"), "zz-personal");
      assert.deepStrictEqual(
        http.requests.map((url) => url.searchParams.get("pageToken")),
        [null, "page-2"],
      );
    }).pipe(
      Effect.provide(OriginCli.layer),
      Effect.provideService(SourceControlHost.SourceControlHost, host),
    ),
  );
});
