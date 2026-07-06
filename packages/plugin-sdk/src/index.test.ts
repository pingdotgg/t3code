import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { definePlugin, HOST_API_VERSION } from "./index.ts";

describe("definePlugin", () => {
  it("preserves the plugin definition shape", () => {
    const definition = definePlugin({
      register: () => Effect.succeed({ rpc: [] }),
    });

    expect(typeof definition.register).toBe("function");
    expect(HOST_API_VERSION).toBe("1.0.0");
  });
});
