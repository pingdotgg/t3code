import { assert, describe, it } from "@effect/vitest";

import { getDefaultBuildArch, resolveHostProcessArch } from "./build-target-arch.ts";

describe("build-target-arch", () => {
  it("prefers arm64 for Windows-on-Arm hosts running x64 emulation", () => {
    // Windows-on-Arm can run an x64 Node process under emulation while still
    // exposing the real host CPU via PROCESSOR_ARCHITEW6432.
    const hostArch = resolveHostProcessArch("win32", "x64", {
      PROCESSOR_ARCHITECTURE: "AMD64", // The currently running Node process is x64.
      PROCESSOR_ARCHITEW6432: "ARM64", // Windows exposes the real host CPU here when x64 runs under ARM emulation.
    });

    assert.equal(hostArch, "arm64");
  });

  it("falls back to x64 for native x64 Windows hosts", () => {
    const hostArch = resolveHostProcessArch("win32", "x64", {
      PROCESSOR_ARCHITECTURE: "AMD64", // Both the process and the Windows host are native x64.
    });

    assert.equal(hostArch, "x64");
  });

  it("keeps arm64 when the current process is already native arm64", () => {
    const hostArch = resolveHostProcessArch("win32", "arm64", {});

    assert.equal(hostArch, "arm64");
  });

  it("uses the resolved host arch when selecting the default Windows build arch", () => {
    // This mirrors the packaging script's default-path behavior: the current
    // process is x64, but the machine itself is ARM64, so the default build
    // target should be win-arm64 rather than win-x64.
    const arch = getDefaultBuildArch(
      "win",
      "x64",
      {
        PROCESSOR_ARCHITECTURE: "AMD64", // The currently running Node process is x64.
        PROCESSOR_ARCHITEW6432: "ARM64", // The process is x64, but the actual Windows host is ARM64.
      },
      { archChoices: ["x64", "arm64"] },
    );

    assert.equal(arch, "arm64");
  });

  it("does not apply Windows host env heuristics for non-Windows targets", () => {
    const arch = getDefaultBuildArch(
      "linux",
      "x64",
      {
        PROCESSOR_ARCHITECTURE: "AMD64",
        PROCESSOR_ARCHITEW6432: "ARM64",
      },
      { archChoices: ["x64", "arm64"] },
    );

    assert.equal(arch, "x64");
  });
});
