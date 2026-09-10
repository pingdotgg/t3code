import { describe, expect, it } from "vitest";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import { makeNodeTarget, target } from "../node.ts";

describe("makeNodeTarget", () => {
  it("is a node target with a wholesale child build and a serve-entry finish", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.build).toBeTypeOf("function");
    expect(node.finish).toBeTypeOf("function");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(typeof node.adapter).toBe("function");
    expect(typeof node.vitePlugins).toBe("function");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
