// @effect-diagnostics-next-line nodeBuiltinImport:off -- Serve a real partial HTTP response.
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "vite-plus/test";
import { waitForHttpReady } from "./httpReadiness.ts";

describe("waitForHttpReady", () => {
  it("becomes ready when the probe after an incomplete response succeeds", async () => {
    let first = true;
    const server = NodeHttp.createServer((_request, response) => {
      if (first) {
        first = false;
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("starting");
        return;
      }
      response.end("ready");
    });
    const listening = new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    server.listen(0, "127.0.0.1");
    await listening;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing TCP address");
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Keep the real HTTP fixture in the async Vitest lifecycle.
      const result = await Effect.runPromise(
        waitForHttpReady({
          baseUrl: `http://127.0.0.1:${address.port}`,
          timeoutMs: 2_000,
          probeTimeoutMs: 250,
          intervalMs: 25,
          makeError: () => ({ _tag: "ReadinessTimeout" as const }),
        }).pipe(
          Effect.as("ready"),
          Effect.orElseSucceed(() => "timed out"),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
      expect(result).toBe("ready");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
