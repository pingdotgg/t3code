import { assert, describe, it } from "@effect/vitest";

import {
  resolveLinuxPackageArch,
  toDebArch,
  toDebVersion,
  toRpmArch,
  toRpmVersion,
} from "./linux-package.ts";

describe("linux-package", () => {
  it("maps supported Node architectures to package architectures", () => {
    assert.equal(resolveLinuxPackageArch("x64"), "x64");
    assert.equal(resolveLinuxPackageArch("arm64"), "arm64");
    assert.equal(resolveLinuxPackageArch("ia32"), undefined);
    assert.equal(toDebArch("x64"), "amd64");
    assert.equal(toDebArch("arm64"), "arm64");
    assert.equal(toRpmArch("x64"), "x86_64");
    assert.equal(toRpmArch("arm64"), "aarch64");
  });

  it("converts stable and prerelease versions to RPM-compatible fields", () => {
    assert.deepEqual(toRpmVersion("1.2.3"), { version: "1.2.3", release: "1" });
    assert.deepEqual(toRpmVersion("1.2.3-nightly.20260611.7"), {
      version: "1.2.3",
      release: "0.1.nightly.20260611.7",
    });
    assert.deepEqual(toRpmVersion("1.2.3+build.5"), {
      version: "1.2.3",
      release: "1.build.5",
    });
  });

  it("converts stable and prerelease versions to Debian-compatible upstream and revision", () => {
    assert.deepEqual(toDebVersion("1.2.3"), { upstream: "1.2.3", revision: "1" });
    assert.deepEqual(toDebVersion("1.2.3-nightly.20260611.7"), {
      upstream: "1.2.3~nightly.20260611.7",
      revision: "1",
    });
    assert.deepEqual(toDebVersion("1.2.3+build.5"), {
      upstream: "1.2.3+build.5",
      revision: "1",
    });
    assert.deepEqual(toDebVersion("1.2.3-nightly.20260611.7+build.5"), {
      upstream: "1.2.3~nightly.20260611.7+build.5",
      revision: "1",
    });
    assert.deepEqual(toDebVersion("1.2.3-alpha-1"), {
      upstream: "1.2.3~alpha-1",
      revision: "1",
    });
  });
});
