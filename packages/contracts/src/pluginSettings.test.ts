import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { PluginManifest } from "./plugin.ts";
import { PluginCatalogSnapshot } from "./pluginCatalog.ts";
import {
  PluginSettingsDeclaration,
  pluginSettingValueProblem,
  resolvePluginSettingValue,
  type PluginSettingField,
} from "./pluginSettingFields.ts";
import { PluginSettingsValues } from "./pluginSettings.ts";

const decodeDeclaration = Schema.decodeUnknownExit(PluginSettingsDeclaration);
const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
const decodeSnapshot = Schema.decodeUnknownSync(PluginCatalogSnapshot);
const decodeValues = Schema.decodeUnknownSync(PluginSettingsValues);
const select = {
  type: "select",
  key: "mode",
  label: "Mode",
  options: [
    { value: "safe", label: "Safe" },
    { value: "fast", label: "Fast" },
  ],
  default: "safe",
} as const;

describe("PluginSettingsDeclaration", () => {
  it("accepts each field type and refuses inconsistent declarations", () => {
    const declaration = [
      { type: "text", key: "apiUrl", label: "API URL", default: "https://example.com" },
      // A default on a secret is not part of its shape and is dropped.
      { type: "secret", key: "token", label: "Token", default: "leaked" },
      { type: "boolean", key: "verbose", label: "Verbose" },
      { type: "number", key: "retries", label: "Retries", min: 0, max: 5, integer: true },
      select,
    ];
    const decoded = decodeDeclaration(declaration);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) expect(decoded.value[1]).not.toHaveProperty("default");

    for (const invalid of [
      [select, select],
      [{ ...select, default: "turbo" }],
      [{ ...select, options: [select.options[0], select.options[0]] }],
      [{ ...select, options: [] }],
      [{ type: "number", key: "n", label: "N", min: 3, max: 1 }],
      [{ type: "number", key: "n", label: "N", integer: true, default: 1.5 }],
      [{ type: "text", key: "1st", label: "First" }],
      [{ type: "color", key: "c", label: "C" }],
    ])
      expect(Exit.isFailure(decodeDeclaration(invalid))).toBe(true);
  });

  it("is optional in the manifest", () => {
    const manifest = decodeManifest({
      id: "acme.notifier",
      name: "Notifier",
      version: "1.0.0",
      apiVersion: 1,
      entry: "main.mjs",
    });
    expect(manifest.settings).toBeUndefined();
  });
});

describe("setting values", () => {
  const retries: PluginSettingField = {
    type: "number",
    key: "retries",
    label: "Retries",
    min: 0,
    max: 5,
    integer: true,
    default: 2,
  };

  it("checks a value against its field", () => {
    expect(pluginSettingValueProblem(retries, 3)).toBeUndefined();
    expect(pluginSettingValueProblem(retries, 6)).toBe("Retries must be at most 5.");
    expect(pluginSettingValueProblem(retries, "3")).toBe("Retries must be a number.");
    expect(pluginSettingValueProblem(select, "fast")).toBeUndefined();
    expect(pluginSettingValueProblem(select, "Fast")).toBe("Mode must be one of its options.");
  });

  it("falls back to the default when a saved value no longer fits its field", () => {
    expect(resolvePluginSettingValue(retries, 4)).toBe(4);
    // For example after an update narrowed the range.
    expect(resolvePluginSettingValue(retries, 9)).toBe(2);
    expect(resolvePluginSettingValue(retries, undefined)).toBe(2);
    expect(
      resolvePluginSettingValue({ type: "secret", key: "token", label: "Token" }, "x"),
    ).toBeUndefined();
  });
});

describe("from a newer server", () => {
  it("drops field types and values this client does not know, not the installation", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const snapshot = decodeSnapshot({
      installations: [
        {
          installationId: "installation-1",
          generation: 1,
          directory: "/srv/plugins/notifier",
          manifest: {
            id: "acme.notifier",
            name: "Notifier",
            version: "1.0.0",
            capabilities: ["settings"],
            proposedApi: true,
            settings: [{ type: "color", key: "accent", label: "Accent" }, select],
          },
          source: { digest, files: 2, bytes: 120 },
          problem: null,
          inspectedAt: "2026-10-04T00:00:00.000Z",
          consent: null,
          enabled: false,
          addedAt: "2026-10-04T00:00:00.000Z",
        },
      ],
    });
    expect(snapshot.installations[0]?.manifest?.settings?.map((field) => field.key)).toEqual([
      "mode",
    ]);

    const values = decodeValues({
      installationId: "installation-1",
      values: [
        { key: "mode", value: "fast" },
        { key: "tags", value: ["a", "b"] },
      ],
      secrets: ["token"],
    });
    expect(values.values).toEqual([{ key: "mode", value: "fast" }]);
  });
});
