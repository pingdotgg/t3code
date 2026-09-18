import { findAvailablePort, nodeLoaderArgs } from "@/Util/Node";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";

describe("Node utilities", () => {
  test("checkout .ts entries get the dev-mode hooks", () => {
    for (const entry of [
      "/repo/packages/alchemy/src/Cloudflare/Local.ts",
      "/repo/src/Runner.tsx",
      "/repo/src/Runner.mts",
    ]) {
      const args = nodeLoaderArgs(entry);
      expect(args[0]).toBe("--import");
      expect(args[1]).toMatch(/\/bin\/register-dev-mode\.js$/);
    }
  });

  test("published .js entries get the Oxc loader alone", () => {
    for (const entry of [
      "/app/node_modules/alchemy/lib/Cloudflare/Local.js",
      "/app/lib/Runner.mjs",
    ]) {
      const args = nodeLoaderArgs(entry);
      expect(args[0]).toBe("--import");
      expect(args[1]).toMatch(/\/bin\/register-oxc\.js$/);
    }
  });

  test("finds and releases an available port", async () => {
    const port = await Effect.runPromise(findAvailablePort());
    expect(port).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => {
      const server = NodeNet.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
  });
});
