import { assert, describe, it } from "@effect/vitest";

import { shouldBundleCliDependency } from "./vite.config.ts";

describe("shouldBundleCliDependency", () => {
  it("bundles direct dependencies and their subpaths", () => {
    assert.isTrue(shouldBundleCliDependency("effect"));
    assert.isTrue(shouldBundleCliDependency("effect/Effect"));
    assert.isTrue(shouldBundleCliDependency("@opencode-ai/sdk/client"));
  });

  it("bundles workspace dependencies", () => {
    assert.isTrue(shouldBundleCliDependency("@t3tools/shared/httpReadiness"));
    assert.isTrue(shouldBundleCliDependency("effect-acp"));
  });

  it("keeps packages that need runtime files external", () => {
    assert.isFalse(shouldBundleCliDependency("node-pty"));
    assert.isFalse(shouldBundleCliDependency("@anthropic-ai/claude-agent-sdk/cli.js"));
    assert.isFalse(shouldBundleCliDependency("node-pty/lib/index.js"));
  });

  it("does not bundle unknown packages", () => {
    assert.isFalse(shouldBundleCliDependency("not-a-server-dependency"));
  });
});
