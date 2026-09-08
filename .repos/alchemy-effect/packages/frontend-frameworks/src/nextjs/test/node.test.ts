import { describe, expect, it } from "vitest";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import {
  SERVER_ENTRY_NAME,
  makeNextServeEntrySource,
  makeNodeTarget,
  target,
} from "../node.ts";

describe("makeNodeTarget", () => {
  it("declares the node platform and a wholesale next build (not OpenNext)", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.build).toBeTypeOf("function");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
  });

  it("writes a next({ dev: false }) serve entry with /health, not OpenNext", () => {
    const source = makeNextServeEntrySource();
    expect(SERVER_ENTRY_NAME).toBe("serve-node.mjs");
    expect(source).toContain('import next from "next"');
    expect(source).toContain("next({ dev: false, dir })");
    expect(source).toContain("getRequestHandler()");
    expect(source).toContain("/health");
    expect(source).toContain("process.env.PORT");
    expect(source).not.toContain("opennext");
    expect(source).not.toContain("aws-lambda");
    expect(source).not.toContain("cloudflare");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
