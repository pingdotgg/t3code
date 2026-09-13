import { findAvailablePort, isTransformTypesSupported } from "@/Util/Node";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";

describe("Node utilities", () => {
  test("detects versions that support --experimental-transform-types", () => {
    expect(isTransformTypesSupported("22.6.0")).toBe(false);
    expect(isTransformTypesSupported("22.7.0")).toBe(true);
    expect(isTransformTypesSupported("25.9.0")).toBe(true);
    expect(isTransformTypesSupported("26.0.0")).toBe(false);
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
