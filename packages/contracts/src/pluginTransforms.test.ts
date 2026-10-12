import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { PluginManifest } from "./plugin.ts";
import { PluginInstallationManifest } from "./pluginCatalog.ts";
import { PluginEnrichResult } from "./pluginTransforms.ts";

const manifest = {
  id: "acme.notes",
  name: "Notes",
  version: "1.0.0",
  apiVersion: 1,
  entry: "main.mjs",
  capabilities: ["transforms"],
  proposedApi: true,
};

describe("PluginManifest.transforms", () => {
  it("accepts an enrich declaration within the deadline bound", () => {
    const decode = Schema.decodeUnknownExit(PluginManifest);
    const declared = decode({ ...manifest, transforms: { enrich: { timeoutSeconds: 10 } } });
    expect(Exit.isSuccess(declared) && declared.value.transforms).toEqual({
      enrich: { timeoutSeconds: 10 },
    });
    expect(
      Exit.isFailure(decode({ ...manifest, transforms: { enrich: { timeoutSeconds: 11 } } })),
    ).toBe(true);
  });
});

describe("PluginEnrichResult", () => {
  const decode = Schema.decodeUnknownExit(PluginEnrichResult);
  const item = { title: "Notes", text: "Use tabs." };

  it("accepts null and bounded context, ignoring fields it does not know", () => {
    expect(Exit.isSuccess(decode(null))).toBe(true);
    const decoded = decode({ context: [item], ttl: 60 });
    expect(Exit.isSuccess(decoded) && decoded.value).toEqual({ context: [item] });
  });

  it("refuses more items or longer text than the limits", () => {
    expect(Exit.isFailure(decode({ context: Array.from({ length: 5 }, () => item) }))).toBe(true);
    expect(Exit.isFailure(decode({ context: [{ title: "Notes", text: "x".repeat(8_001) }] }))).toBe(
      true,
    );
    expect(Exit.isFailure(decode({ context: [{ title: " ", text: "Use tabs." }] }))).toBe(true);
  });
});

describe("PluginInstallationManifest.transforms from a newer server", () => {
  it("drops a declaration shape this client does not know and keeps the row", () => {
    const decode = Schema.decodeUnknownExit(PluginInstallationManifest);
    const decoded = decode({ ...manifest, transforms: { enrich: { timeoutSeconds: 60 } } });
    expect(Exit.isSuccess(decoded)).toBe(true);
    expect(Exit.isSuccess(decoded) && decoded.value.transforms).toBeUndefined();
  });
});
