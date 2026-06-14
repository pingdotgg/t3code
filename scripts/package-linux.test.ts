// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDebianPackageMetadata } from "./package-linux.ts";

describe("writeDebianPackageMetadata", () => {
  it("writes control, conffiles, and executable maintainer scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "morecode-deb-test-"));
    try {
      const serverPackage = {
        version: "0.0.24",
        license: "MIT",
        repository: { url: "https://example.com/repo" },
      };

      writeDebianPackageMetadata(root, serverPackage, "x64", ["/etc/morecode/morecode.env"]);

      const control = readFileSync(join(root, "DEBIAN/control"), "utf8");
      assert.include(control, "Package: morecode-headless");
      assert.include(control, "Version: 0.0.24-1");
      assert.include(control, "Architecture: amd64");
      assert.include(control, "Homepage: https://example.com/repo");

      const conffiles = readFileSync(join(root, "DEBIAN/conffiles"), "utf8");
      assert.include(conffiles, "/etc/morecode/morecode.env");

      for (const script of ["postinst", "prerm", "postrm"]) {
        const path = join(root, "DEBIAN", script);
        assert.isTrue(existsSync(path), `${script} should exist`);
        const mode = statSync(path).mode & 0o777;
        assert.equal(mode, 0o755, `${script} should be executable`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits the conffiles file when no conffiles are given", () => {
    const root = mkdtempSync(join(tmpdir(), "morecode-deb-test-"));
    try {
      const serverPackage = {
        version: "0.0.24",
        license: "MIT",
        repository: { url: "https://example.com/repo" },
      };

      writeDebianPackageMetadata(root, serverPackage, "arm64", []);

      assert.isFalse(existsSync(join(root, "DEBIAN/conffiles")));
      const control = readFileSync(join(root, "DEBIAN/control"), "utf8");
      assert.include(control, "Architecture: arm64");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes prerelease versions for Debian control files", () => {
    const root = mkdtempSync(join(tmpdir(), "morecode-deb-test-"));
    try {
      const serverPackage = {
        version: "0.0.24-nightly.20260611.7",
        license: "MIT",
        repository: { url: "https://example.com/repo" },
      };

      writeDebianPackageMetadata(root, serverPackage, "x64", []);

      const control = readFileSync(join(root, "DEBIAN/control"), "utf8");
      assert.include(control, "Version: 0.0.24~nightly.20260611.7-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
