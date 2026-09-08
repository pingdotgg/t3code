import { describe, expect, it } from "vitest";
import {
  makeCloudflareTarget,
  NITRO_HANDLER_SPECIFIER,
  NITRO_PRESET,
} from "../cloudflare.ts";
import type { NitroConfigSlice } from "../UserConfig.ts";

describe("makeCloudflareTarget", () => {
  it("declares the cloudflare platform, the nitro preset, and workerd bundle settings", () => {
    const target = makeCloudflareTarget();
    expect(target.platform).toBe("cloudflare");
    expect(target.nitroPreset).toBe(NITRO_PRESET);
    expect(target.bundle?.conditions).toEqual([
      "workerd",
      "worker",
      "module",
      "browser",
    ]);
    expect(target.bundle?.external).toEqual(["cloudflare:"]);
    // No wholesale build and no finishing pass: nitro's cloudflare_module
    // output is already workerd ESM.
    expect(target.build).toBeUndefined();
    expect(target.finish).toBeUndefined();
  });

  it("surfaces a configured main through the generic user-entry carriage", () => {
    expect(makeCloudflareTarget().entry).toBeUndefined();
    expect(makeCloudflareTarget({ main: "./worker-entry.ts" }).entry).toEqual({
      main: "./worker-entry.ts",
    });
  });

  it("enforces wrangler-free nitro config: deployConfig off, nodeCompat on", () => {
    const target = makeCloudflareTarget();
    const config: NitroConfigSlice = {};
    target.configureNitro?.(config, { root: "/project" });
    expect(config.cloudflare).toEqual({
      deployConfig: false,
      nodeCompat: true,
    });
    expect(config.entry).toBeUndefined();
  });

  it("preserves foreign cloudflare keys while overriding the owned ones", () => {
    const target = makeCloudflareTarget();
    const config: NitroConfigSlice = {
      cloudflare: { deployConfig: true, pages: { routes: [] } },
    };
    target.configureNitro?.(config, { root: "/project" });
    expect(config.cloudflare).toEqual({
      deployConfig: false,
      nodeCompat: true,
      pages: { routes: [] },
    });
  });

  it("honors an explicit nodeCompat opt-out", () => {
    const target = makeCloudflareTarget({ nodeCompat: false });
    const config: NitroConfigSlice = {};
    target.configureNitro?.(config, { root: "/project" });
    expect(config.cloudflare).toEqual({
      deployConfig: false,
      nodeCompat: false,
    });
  });

  it("does NOT wire the user entry at the config level (prerender-clone safety)", () => {
    // The framework package sets the entry on the nitro INSTANCE at
    // `nitro:init`; a config-level entry would leak into the prerenderer's
    // Node-preset clone, which cannot load `cloudflare:` imports.
    const target = makeCloudflareTarget({ main: "./worker-entry.ts" });
    const config: NitroConfigSlice = {};
    target.configureNitro?.(config, {
      root: "/project",
      entry: "/project/worker-entry.ts",
    });
    expect(config.entry).toBeUndefined();
  });

  it("exports the wrappable-handler specifier for user entries", () => {
    expect(NITRO_HANDLER_SPECIFIER).toBe(
      "nitropack/presets/cloudflare/runtime/cloudflare-module",
    );
  });
});
