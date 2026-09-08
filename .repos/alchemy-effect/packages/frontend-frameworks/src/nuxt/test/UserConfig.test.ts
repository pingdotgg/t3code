import { describe, expect, it } from "vitest";
import {
  enforceNitroConfig,
  findPresetConflict,
  isSamePreset,
  makeNuxtOverrides,
  normalizePresetName,
  presetConflictMessage,
  type NitroConfigSlice,
} from "../UserConfig.ts";

describe("normalizePresetName / isSamePreset", () => {
  it("treats snake, kebab, and camel spellings as the same preset", () => {
    expect(normalizePresetName("cloudflare_module")).toBe("cloudflare-module");
    expect(normalizePresetName("cloudflare-module")).toBe("cloudflare-module");
    expect(normalizePresetName("cloudflareModule")).toBe("cloudflare-module");
    expect(isSamePreset("cloudflare_module", "cloudflare-module")).toBe(true);
    expect(isSamePreset("cloudflareModule", "cloudflare_module")).toBe(true);
  });

  it("distinguishes genuinely different presets", () => {
    expect(isSamePreset("cloudflare_module", "cloudflare_pages")).toBe(false);
    expect(isSamePreset("cloudflare_module", "cloudflare_durable")).toBe(false);
    expect(isSamePreset("cloudflare_module", "vercel")).toBe(false);
  });
});

describe("makeNuxtOverrides", () => {
  it("injects the target preset into the nitro overrides", () => {
    const overrides = makeNuxtOverrides({ nitroPreset: "cloudflare_module" });
    expect(overrides).toEqual({
      vite: { logLevel: "warn" },
      nitro: { preset: "cloudflare_module" },
    });
  });

  it("lets integration-level vite config override the reporter-safe defaults", () => {
    const overrides = makeNuxtOverrides({
      nuxtConfig: { vite: { logLevel: "info", clearScreen: false } },
    });
    expect(overrides["vite"]).toEqual({ logLevel: "info", clearScreen: false });
  });

  it("merges integration-level nuxt config, with the preset winning over its nitro slice", () => {
    const overrides = makeNuxtOverrides({
      nitroPreset: "cloudflare_module",
      nuxtConfig: {
        ssr: true,
        nitro: { preset: "vercel", minify: false },
      },
    });
    expect(overrides["ssr"]).toBe(true);
    expect(overrides["nitro"]).toEqual({
      preset: "cloudflare_module",
      minify: false,
    });
  });

  it("appends nitro plugins after integration-declared ones", () => {
    const overrides = makeNuxtOverrides({
      nitroPreset: "cloudflare_module",
      nuxtConfig: { nitro: { plugins: ["a-plugin.ts"] } },
      nitroPlugins: ["/abs/dev-bridge.ts"],
    });
    expect((overrides["nitro"] as { plugins: Array<string> }).plugins).toEqual([
      "a-plugin.ts",
      "/abs/dev-bridge.ts",
    ]);
  });

  it("omits the preset for dev-shaped overrides (no nitroPreset) while still appending plugins", () => {
    const overrides = makeNuxtOverrides({
      nuxtConfig: { telemetry: false },
      nitroPlugins: ["/abs/dev-bridge.ts"],
    });
    expect(overrides["telemetry"]).toBe(false);
    expect(overrides["nitro"]).toEqual({ plugins: ["/abs/dev-bridge.ts"] });
  });

  it("merges injected runtimeConfig over the integration overrides' runtimeConfig", () => {
    const overrides = makeNuxtOverrides({
      nuxtConfig: { runtimeConfig: { keep: "user", clobbered: "user" } },
      runtimeConfig: {
        clobbered: "platform",
        injected: { url: "http://127.0.0.1:1", token: "t" },
      },
    });
    expect(overrides["runtimeConfig"]).toEqual({
      keep: "user",
      clobbered: "platform",
      injected: { url: "http://127.0.0.1:1", token: "t" },
    });
  });

  it("adds no runtimeConfig key when none is injected", () => {
    const overrides = makeNuxtOverrides({ nitroPreset: "cloudflare_module" });
    expect("runtimeConfig" in overrides).toBe(false);
  });

  it("adds no plugins key when none are given", () => {
    const overrides = makeNuxtOverrides({ nitroPreset: "cloudflare_module" });
    expect("plugins" in (overrides["nitro"] as Record<string, unknown>)).toBe(
      false,
    );
  });
});

describe("findPresetConflict", () => {
  const layer = (preset: string | undefined, cwd = "/project") => ({
    cwd,
    config: preset !== undefined ? { nitro: { preset } } : {},
  });

  it("returns undefined when no layer sets a preset", () => {
    expect(
      findPresetConflict([layer(undefined)], "cloudflare_module"),
    ).toBeUndefined();
    expect(findPresetConflict([], "cloudflare_module")).toBeUndefined();
    expect(findPresetConflict(undefined, "cloudflare_module")).toBeUndefined();
  });

  it("accepts the target preset and its spelling aliases", () => {
    expect(
      findPresetConflict([layer("cloudflare_module")], "cloudflare_module"),
    ).toBeUndefined();
    expect(
      findPresetConflict([layer("cloudflare-module")], "cloudflare_module"),
    ).toBeUndefined();
    expect(
      findPresetConflict([layer("cloudflareModule")], "cloudflare_module"),
    ).toBeUndefined();
  });

  it("surfaces a foreign preset from any layer", () => {
    expect(findPresetConflict([layer("vercel")], "cloudflare_module")).toBe(
      "vercel",
    );
    expect(
      findPresetConflict(
        [layer(undefined), layer("cloudflare_pages", "/project/base")],
        "cloudflare_module",
      ),
    ).toBe("cloudflare_pages");
  });

  it("ignores empty-string presets", () => {
    expect(
      findPresetConflict([layer("")], "cloudflare_module"),
    ).toBeUndefined();
  });
});

describe("presetConflictMessage", () => {
  it("names both presets and the fix", () => {
    const message = presetConflictMessage("vercel", "cloudflare_module");
    expect(message).toContain('"vercel"');
    expect(message).toContain('"cloudflare_module"');
    expect(message).toContain("nitro.preset");
  });
});

describe("enforceNitroConfig", () => {
  it("enforces the preset as the last word", () => {
    const config: NitroConfigSlice = { preset: "node-server" };
    enforceNitroConfig(config, { preset: "cloudflare_module" });
    expect(config.preset).toBe("cloudflare_module");
  });

  it("runs the target's configure pass after the preset is set", () => {
    const config: NitroConfigSlice = {};
    const seen: Array<string | undefined> = [];
    enforceNitroConfig(config, {
      preset: "cloudflare_module",
      configure: (nitroConfig) => {
        seen.push(nitroConfig.preset);
        nitroConfig.cloudflare = { deployConfig: false };
      },
    });
    expect(seen).toEqual(["cloudflare_module"]);
    expect(config.cloudflare).toEqual({ deployConfig: false });
  });
});
