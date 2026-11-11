import * as NodeNet from "node:net";
import { describe, expect, test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { findAvailablePort, isRegisterHooksSupported, nodeLoaderArgs } from "@/Util/Node";

describe("Node utilities", { tags: ["unit", "local"] }, () => {
  test("module hooks are supported from 22.22.3, 24.11.1, 25.1 and 26", () => {
    const supported = [
      "22.22.3",
      "22.23.4",
      "24.11.1",
      "24.12.0",
      "24.18.0",
      "25.1.0",
      "25.9.0",
      "26.0.0",
      "26.2.0",
    ];
    const unsupported = [
      "22.12.0",
      "22.19.0",
      "22.22.2",
      "23.11.0",
      "24.5.0",
      "24.10.9",
      "24.11.0",
      "25.0.0",
      "25.0.2",
    ];
    for (const version of supported)
      expect([version, isRegisterHooksSupported(version)]).toEqual([version, true]);
    for (const version of unsupported)
      expect([version, isRegisterHooksSupported(version)]).toEqual([version, false]);
  });

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
