import { isDeployTarget } from "../../core/index.ts";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import { describe, expect, it } from "vitest";
import { makeNodeAdapter, makeNodeTarget, target } from "../node.ts";

describe("makeNodeTarget", () => {
  it("is a DeployTarget for the node platform with a finish pass", () => {
    const node = makeNodeTarget({
      adapter: { notFoundHandling: "single-page-application" },
    });
    expect(isDeployTarget(node)).toBe(true);
    expect(node.platform).toBe("node");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
    expect(node.build).toBeTypeOf("function");
    expect(node.finish).toBeTypeOf("function");
  });

  it("produces the in-memory kit adapter from the adapter hook", () => {
    const adapter = makeNodeAdapter();
    expect(adapter.name).toBe(
      "@alchemy.run/frontend-frameworks/sveltekit/node",
    );
    expect(adapter.result.current).toBeUndefined();
    expect(typeof adapter.adapt).toBe("function");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
