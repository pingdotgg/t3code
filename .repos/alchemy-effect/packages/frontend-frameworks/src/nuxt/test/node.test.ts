import { describe, expect, it } from "vitest";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import type { NitroConfigSlice } from "../UserConfig.ts";
import {
  NITRO_HANDLER_SPECIFIER,
  NITRO_PRESET,
  makeNodeTarget,
  target,
} from "../node.ts";

describe("makeNodeTarget", () => {
  it("declares the node platform, the node nitro preset, and a finish pass", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.nitroPreset).toBe(NITRO_PRESET);
    expect(NITRO_PRESET).toBe("node");
    expect(NITRO_PRESET).not.toBe("aws-lambda");
    expect(NITRO_PRESET).not.toBe("cloudflare_module");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
    expect(node.build).toBeTypeOf("function");
    expect(node.finish).toBeTypeOf("function");
  });

  it("does not wire the user entry at the config level", () => {
    const node = makeNodeTarget({ main: "./server-entry.ts" });
    const config: NitroConfigSlice = {};
    node.configureNitro?.(config, {
      root: "/project",
      entry: "/project/server-entry.ts",
    });
    expect(config.entry).toBeUndefined();
  });

  it("exports the node-listener handler specifier for user entries", () => {
    expect(NITRO_HANDLER_SPECIFIER).toBe(
      "nitropack/presets/node/runtime/node-listener",
    );
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
