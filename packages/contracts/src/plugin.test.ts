import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PluginManifest } from "./plugin.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

describe("PluginManifest", () => {
  it("decodes a multi-page view plugin", () => {
    const manifest = decodeManifest({
      schemaVersion: 1,
      id: "deploy-tools",
      name: "Deploy tools",
      backend: "dist/backend.mjs",
      commands: [
        { name: "dashboard", title: "Dashboard", entry: "dist/dashboard.html" },
        { name: "logs", title: "Logs", entry: "dist/logs.html" },
      ],
    });
    expect(manifest.commands).toHaveLength(2);
    expect(manifest.backend).toBe("dist/backend.mjs");
  });

  it.each([
    "../outside.html",
    "/absolute.html",
    "dist/.hidden.html",
    "dist//page.html",
    "dist/page.js",
  ])("rejects unsafe or unsupported entry %s", (entry) => {
    expect(() =>
      decodeManifest({
        schemaVersion: 1,
        id: "deploy-tools",
        name: "Deploy tools",
        commands: [{ name: "home", title: "Home", entry }],
      }),
    ).toThrow();
  });

  it.each(["../backend.mjs", "/backend.mjs", "dist/.backend.mjs", "dist/backend.ts"])(
    "rejects unsafe or unsupported backend %s",
    (backend) => {
      expect(() =>
        decodeManifest({
          schemaVersion: 1,
          id: "deploy-tools",
          name: "Deploy tools",
          backend,
          commands: [{ name: "home", title: "Home", entry: "dist/home.html" }],
        }),
      ).toThrow();
    },
  );
});
