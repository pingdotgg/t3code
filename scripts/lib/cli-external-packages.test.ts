import { assert, describe, it } from "@effect/vitest";

import {
  CLI_EXTERNAL_PACKAGE_PREFIXES,
  CLI_EXTERNAL_PACKAGE_UNPACK_GLOBS,
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
