import { describe, expect, it } from "vitest";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import { makeNodeTarget, target } from "../node.ts";

describe("makeNodeTarget", () => {
  it("is an assets-only node target whose only seam is the wholesale child build", () => {
    const node = makeNodeTarget({ vite: { outDir: "dist" } });
    expect(node.platform).toBe("node");
    expect(node.build).toBeTypeOf("function");
    expect(node.finish).toBeTypeOf("function");
    expect(node.entry).toBeUndefined();
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
    expect(node.config).toEqual({ vite: { outDir: "dist" } });
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
