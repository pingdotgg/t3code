import { describe, expect, it } from "vitest";

import { shouldBundleCliDependency } from "./vite.config.ts";

describe("shouldBundleCliDependency", () => {
  it("bundles patched Effect websocket servers into the published CLI", () => {
    expect(shouldBundleCliDependency("@effect/platform-node/NodeHttpServer")).toBe(true);
    expect(shouldBundleCliDependency("@effect/platform-bun/BunHttpServer")).toBe(true);
  });
});
