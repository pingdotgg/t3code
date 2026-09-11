import { describe, expect, it } from "vitest";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import { ADAPTER_NAME as MARKER_NAME, node } from "../node-adapter.ts";
import {
  ADAPTER_NAME,
  ADAPTER_PACKAGE,
  SERVER_ENTRY_FILE_NAME,
  makeNodeTarget,
  target,
} from "../node.ts";

describe("makeNodeTarget", () => {
  it("declares the node adapter contract octane.config.ts must satisfy", () => {
    const nodeTarget = makeNodeTarget({ compatibilityDate: "2026-03-10" });
    expect(nodeTarget.platform).toBe("node");
    expect(nodeTarget.adapterName).toBe(ADAPTER_NAME);
    expect(nodeTarget.adapterPackage).toBe(ADAPTER_PACKAGE);
    expect(nodeTarget.serverEntryFileName).toBe(SERVER_ENTRY_FILE_NAME);
    expect(SERVER_ENTRY_FILE_NAME).toBe("entry.js");
    expect(nodeTarget.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(nodeTarget.finish).toBeTypeOf("function");
    expect(nodeTarget.build).toBeTypeOf("function");
  });

  it("exposes a dependency-free marker adapter named node", () => {
    expect(MARKER_NAME).toBe("node");
    expect(node()).toEqual({ name: "node", serverTarget: "node" });
    expect(ADAPTER_PACKAGE).toBe(
      "@alchemy.run/frontend-frameworks/octane/node-adapter",
    );
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
