import { describe, expect, it } from "vite-plus/test";

import { createEffectScopeRuntime } from "./effectScopeRuntime.ts";
import { defineRuntimeContract } from "./runtimeContract.ts";

defineRuntimeContract("effect scope runtime", createEffectScopeRuntime);

describe("effect scope runtime errors", () => {
  it("returns schema-tagged planning errors", async () => {
    const runtime = createEffectScopeRuntime();
    const duplicate = {
      id: "acme.duplicate",
      version: "1.0.0",
      activate() {},
    };

    await expect(runtime.reconcile([duplicate, duplicate])).rejects.toMatchObject({
      _tag: "DuplicatePluginIdError",
      pluginId: "acme.duplicate",
    });
  });
});
