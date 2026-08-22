import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PluginManifest } from "../src/manifest.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

const validManifest = {
  id: "com.acme.linear",
  version: "1.2.0",
  engines: { t3: "^0.1.0" },
  entrypoints: {
    server: "./dist/server.js",
    web: "./dist/web.js",
  },
  requires: ["t3.commands@1", "t3.secrets@1"],
  provides: ["com.acme.linear@1"],
  permissions: ["network:https://api.linear.app", "secrets:linear-token"],
  contributes: {
    commands: ["linear.create-issue"],
    settings: ["linear.settings"],
    views: ["thread.right-panel"],
  },
};

describe("PluginManifest", () => {
  it("decodes a namespaced multi-surface plugin manifest", () => {
    expect(decodeManifest(validManifest)).toEqual(validManifest);
  });

  it("rejects unnamespaced plugin and contribution ids", () => {
    expect(() => decodeManifest({ ...validManifest, id: "linear" })).toThrow();
    expect(() =>
      decodeManifest({
        ...validManifest,
        contributes: { ...validManifest.contributes, commands: ["create-issue"] },
      }),
    ).toThrow();
  });

  it("rejects malformed versions and capability ids", () => {
    expect(() => decodeManifest({ ...validManifest, version: "next" })).toThrow();
    expect(() => decodeManifest({ ...validManifest, version: "01.2.3" })).toThrow();
    expect(() => decodeManifest({ ...validManifest, version: "1.2.3-.." })).toThrow();
    expect(decodeManifest({ ...validManifest, version: "1.2.3+build.7" }).version).toBe(
      "1.2.3+build.7",
    );
    expect(() => decodeManifest({ ...validManifest, requires: ["t3.commands"] })).toThrow();
  });

  it("rejects entrypoints that escape the plugin directory", () => {
    for (const server of ["./../outside.js", "./dist/../../outside.js"]) {
      expect(() =>
        decodeManifest({
          ...validManifest,
          entrypoints: { ...validManifest.entrypoints, server },
        }),
      ).toThrow();
    }
  });

  it("keeps mobile declarative by excluding a mobile executable entrypoint", () => {
    const decoded = decodeManifest({
      ...validManifest,
      surfaces: ["web", "desktop", "mobile"],
      contributes: { ...validManifest.contributes, mobileCards: ["linear.summary"] },
    });

    expect(decoded.surfaces).toEqual(["web", "desktop", "mobile"]);
    expect(decoded.contributes.mobileCards).toEqual(["linear.summary"]);
    expect(decoded.entrypoints).not.toHaveProperty("mobile");
    expect(() =>
      decodeManifest({
        ...validManifest,
        entrypoints: { ...validManifest.entrypoints, mobile: "./dist/mobile.js" },
      }),
    ).toThrow();
  });
});
