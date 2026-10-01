import { isDeployTarget } from "../../core/index.ts";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { makeNodeTarget, target } from "../node.ts";

const context = {
  root: "/project",
  wakuDirectory: "/project/node_modules/waku",
  phase: "build" as const,
};

describe("makeNodeTarget", () => {
  it("declares the node platform, empty vite plugins, and a finish pass", async () => {
    const node = makeNodeTarget();
    expect(isDeployTarget(node)).toBe(true);
    expect(node.platform).toBe("node");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.build).toBeTypeOf("function");
    expect(node.finish).toBeTypeOf("function");
    const plugins = await Effect.runPromise(node.vitePlugins(context));
    expect(plugins).toEqual([]);
  });

  it("selects waku's node adapter from the project's waku package", async () => {
    const node = makeNodeTarget();
    const adapter = await Effect.runPromise(node.adapter(context));
    expect(adapter).toBe(
      NodePath.join(context.wakuDirectory, "dist/adapters/node.js"),
    );
    expect(adapter).not.toContain("aws-adapter");
    expect(adapter).not.toContain("cloudflare");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
