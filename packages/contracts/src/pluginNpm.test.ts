import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { PluginNpmAddInput, PluginNpmListResult } from "./pluginNpm.ts";

const decodeAddInput = Schema.decodeUnknownExit(PluginNpmAddInput);
const decodeList = Schema.decodeUnknownExit(PluginNpmListResult);
const acceptsVersion = (version: string) =>
  Exit.isSuccess(decodeAddInput({ name: "t3-plugin-hello", version }));
const acceptsName = (name: string) => Exit.isSuccess(decodeAddInput({ name, version: "1.0.0" }));

describe("PluginNpm inputs", () => {
  it("takes exact versions and dist-tags but never a range", () => {
    for (const exact of ["1.0.0", "0.0.1", "1.2.3-beta.1", "1.2.3+build.5", "latest", "next"])
      expect(acceptsVersion(exact), exact).toBe(true);
    for (const range of [
      "^1.0.0",
      "~1.2.0",
      "1.x",
      "x",
      "*",
      ">=1.0.0",
      "1",
      "1.0",
      "1.0.0 || 2.0.0",
      "01.0.0",
    ])
      expect(acceptsVersion(range), range).toBe(false);
  });

  it("takes npm package names, scoped or not", () => {
    for (const name of ["t3-plugin-hello", "@acme/notifier", "a.b_c~d"])
      expect(acceptsName(name), name).toBe(true);
    for (const name of ["Uppercase", "@acme", "../escape", "@acme/../x", "a/b", ""])
      expect(acceptsName(name), name).toBe(false);
  });
});

describe("PluginNpmListResult from a newer server", () => {
  it("ignores fields this client does not know", () => {
    const decoded = decodeList({
      packages: [
        {
          installationId: "installation-1",
          source: {
            registry: "https://registry.example",
            name: "t3-plugin-hello",
            version: "1.0.0",
            integrity: `sha512-${"A".repeat(86)}==`,
            installedAt: "2026-10-04T00:00:00.000Z",
            signedBy: "a later server field",
          },
          stagedUpdate: null,
          channel: "a later server field",
        },
      ],
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });
});
