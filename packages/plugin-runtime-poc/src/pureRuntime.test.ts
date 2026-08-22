import { describe, expect, it } from "vite-plus/test";

import type { PluginDefinition } from "./contract.ts";
import { createPureRuntime } from "./pureRuntime.ts";
import { defineRuntimeContract } from "./runtimeContract.ts";

defineRuntimeContract("pure reconciliation runtime", createPureRuntime);

describe("pure reconciliation planner", () => {
  it("plans a deep acyclic dependency chain without using the call stack", async () => {
    const runtime = createPureRuntime();
    const pluginCount = 20_000;
    const definitions: Array<PluginDefinition> = Array.from(
      { length: pluginCount },
      (_, index) => ({
        id: `plugin-${index}`,
        version: "1.0.0",
        ...(index === 0 ? {} : { requires: [`capability-${index - 1}`] }),
        provides: { [`capability-${index}`]: index },
        activate() {},
      }),
    );

    const snapshot = await runtime.reconcile(definitions.toReversed());

    expect(snapshot.active).toHaveLength(pluginCount);
    await runtime.dispose();
  });
});
