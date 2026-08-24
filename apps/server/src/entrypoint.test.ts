// @effect-diagnostics nodeBuiltinImport:off - entrypoint detection is a Node filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { isEntrypoint } from "./entrypoint.ts";

const makeTempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-entrypoint-test-"));

describe("isEntrypoint", () => {
  it("uses the runtime answer when Node provides one", () => {
    // Node 22.18+ and 24.2+ populate `import.meta.main`; nothing else is consulted.
    expect(
      isEntrypoint({
        moduleUrl: "file:///somewhere/bin.mjs",
        entryPath: "/elsewhere/other.mjs",
        runtimeMain: true,
      }),
    ).toBe(true);
    expect(
      isEntrypoint({
        moduleUrl: "file:///somewhere/bin.mjs",
        entryPath: "/somewhere/bin.mjs",
        runtimeMain: false,
      }),
    ).toBe(false);
  });

  it("matches the entrypoint path when the runtime has no import.meta.main", () => {
    // Node 22.16, 22.17 and 23.11 are inside `engines.node` but leave it undefined.
    const dir = makeTempDir();
    const entry = NodePath.join(dir, "bin.mjs");
    NodeFS.writeFileSync(entry, "");

    expect(
      isEntrypoint({
        moduleUrl: NodeURL.pathToFileURL(entry).href,
        entryPath: entry,
        runtimeMain: undefined,
      }),
    ).toBe(true);
  });

  it("matches through a symlinked entrypoint, as npm and npx install it", () => {
    const dir = makeTempDir();
    const real = NodePath.join(dir, "bin.mjs");
    const link = NodePath.join(dir, "t3");
    NodeFS.writeFileSync(real, "");
    NodeFS.symlinkSync(real, link);

    expect(
      isEntrypoint({
        moduleUrl: NodeURL.pathToFileURL(real).href,
        entryPath: link,
        runtimeMain: undefined,
      }),
    ).toBe(true);
  });

  it("stays false for an imported module that is not the entrypoint", () => {
    // This is what keeps `bin.test.ts` from launching the CLI on import.
    const dir = makeTempDir();
    const entry = NodePath.join(dir, "bin.mjs");
    const imported = NodePath.join(dir, "cli.mjs");
    NodeFS.writeFileSync(entry, "");
    NodeFS.writeFileSync(imported, "");

    expect(
      isEntrypoint({
        moduleUrl: NodeURL.pathToFileURL(imported).href,
        entryPath: entry,
        runtimeMain: undefined,
      }),
    ).toBe(false);
  });

  it("stays false when there is no entrypoint argument", () => {
    expect(
      isEntrypoint({
        moduleUrl: "file:///somewhere/bin.mjs",
        entryPath: undefined,
        runtimeMain: undefined,
      }),
    ).toBe(false);
  });
});
