import { assert, describe, it } from "@effect/vitest";

import {
  CLI_EXTERNAL_PACKAGE_PREFIXES,
  CLI_EXTERNAL_PACKAGE_UNPACK_GLOBS,
  CLI_RUNTIME_EXTERNAL_PREFIXES,
  shouldBundleCliDependency,
} from "./cli-external-packages.ts";

describe("shouldBundleCliDependency", () => {
  it("bundles ordinary runtime dependencies", () => {
    for (const id of ["effect", "@effect/platform", "hono", "@t3tools/shared/hostProcess"]) {
      assert.strictEqual(shouldBundleCliDependency(id), true, id);
    }
  });

  it("never bundles node: builtins", () => {
    assert.strictEqual(shouldBundleCliDependency("node:fs"), false);
  });

  it("leaves native addons and their dlopen wrappers external", () => {
    for (const id of [
      "node-pty",
      "ffi-rs",
      "@yuuang/ffi-rs-win32-x64-msvc",
      "@ff-labs/fff-node",
      "@clerk/electron-passkeys",
      "msgpackr-extract",
      "@msgpackr-extract/msgpackr-extract-win32-x64",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(id), false, id);
    }
  });

  it("leaves bun-only entry points external", () => {
    assert.strictEqual(shouldBundleCliDependency("@effect/platform-bun"), false);
    assert.strictEqual(shouldBundleCliDependency("@effect/sql-sqlite-bun"), false);
  });

  // The real package is `node-gyp-build-optional-packages`, reached by prefix.
  // Matching it as external while failing to unpack it is invisible on the
  // Windows primary (which reads app.asar) and breaks only under WSL.
  it("treats prefix-matched siblings as external", () => {
    assert.strictEqual(shouldBundleCliDependency("node-gyp-build-optional-packages"), false);
  });
});

describe("CLI_EXTERNAL_PACKAGE_UNPACK_GLOBS", () => {
  it("unpacks every external prefix from both the top level and the pnpm store", () => {
    for (const prefix of CLI_EXTERNAL_PACKAGE_PREFIXES) {
      assert.include(CLI_EXTERNAL_PACKAGE_UNPACK_GLOBS, `node_modules/${prefix}*/**/*`, prefix);
      assert.include(
        CLI_EXTERNAL_PACKAGE_UNPACK_GLOBS,
        `node_modules/.pnpm/**/node_modules/${prefix}*/**/*`,
        prefix,
      );
    }
  });

  // Without the trailing `*` the globs stop covering prefix-matched siblings,
  // which is exactly how a package ends up external but not unpacked.
  it("keeps the trailing wildcard that matches prefix siblings", () => {
    assert.include(CLI_EXTERNAL_PACKAGE_UNPACK_GLOBS, "node_modules/node-gyp-build*/**/*");
  });
});

// The failure this guards is invisible on Windows and fatal under WSL.
//
// An external package is loaded from the real filesystem, so its own `require`
// also resolves from the real filesystem. If one of its dependencies was
// bundled away instead of left external, that dependency exists only inside
// app.asar — which the Windows primary reads transparently under
// ELECTRON_RUN_AS_NODE, and plain `node` under WSL cannot.
//
// Found the hard way: node-gyp-build-optional-packages requires detect-libc,
// which was bundled. Windows was fine; WSL got MODULE_NOT_FOUND.
describe("external package dependency closure", () => {
  // Must be runtime-external specifically: the dependency has to exist on disk.
  const isExternal = (name: string) =>
    CLI_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix));

  it("keeps every runtime dependency of an external package external too", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);

    const violations: string[] = [];
    const seen = new Set<string>();
    // Only the runtime-external set. The build-only entries resolve `bun:*`
    // and are never loaded by Node, so their closure is irrelevant here.
    const queue: string[] = CLI_RUNTIME_EXTERNAL_PREFIXES.filter((prefix) => !prefix.endsWith("/"));

    for (const name of queue) {
      if (seen.has(name)) continue;
      seen.add(name);

      let manifest: { dependencies?: Record<string, string> };
      try {
        manifest = require(`${name}/package.json`);
      } catch {
        // Not installed on this platform (or reached only by prefix); nothing
        // to check. The globs still cover it if it does get installed.
        continue;
      }

      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (!isExternal(dependency)) {
          violations.push(`${name} -> ${dependency}`);
        }
        if (!seen.has(dependency)) queue.push(dependency);
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      `these dependencies of external packages would be bundled away, and fail to resolve under WSL: ${violations.join(", ")}`,
    );
  });
});
