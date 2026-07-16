import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { selectCodexProviderMaintenanceCapabilities } from "./codexMaintenance.ts";
import {
  createProviderVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
} from "./providerMaintenance.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const codexLegacyResolver = makePackageManagedProviderMaintenanceResolver({
  provider: CODEX_DRIVER,
  npmPackageName: "@openai/codex",
  homebrewFormula: "codex",
  nativeUpdate: null,
});

function select(version: string | null | undefined, binaryPath?: string) {
  const legacyCapabilities = codexLegacyResolver.resolve(binaryPath ? { binaryPath } : undefined);
  return selectCodexProviderMaintenanceCapabilities({
    installedVersion: version,
    legacyCapabilities,
  });
}

describe("codexMaintenance", () => {
  it.each([
    ["0.128.0", "stable boundary"],
    ["0.128.0+build.1", "stable boundary with build metadata"],
    ["0.128.1", "newer stable"],
    ["0.129.0-alpha.1", "newer prerelease"],
  ])("uses codex update for %s (%s)", (version) => {
    expect(select(version)).toEqual({
      provider: CODEX_DRIVER,
      packageName: "@openai/codex",
      update: {
        command: "codex update",
        executable: "codex",
        args: ["update"],
        lockKey: "codex-native",
      },
    });
  });

  it.each([
    ["0.127.9", "below the stable boundary"],
    ["0.128.0-alpha.1", "prerelease at the stable boundary"],
    ["0.126.0-alpha.9", "supporting prerelease below the stable boundary"],
    [null, "missing version"],
    [undefined, "undetermined version"],
    ["not-a-version", "malformed version"],
    ["0.128", "incomplete version"],
    ["0.129.0-alpha!", "malformed prerelease"],
  ])("retains the legacy npm update for %s (%s)", (version, _description) => {
    expect(select(version)).toEqual({
      provider: CODEX_DRIVER,
      packageName: "@openai/codex",
      update: {
        command: "npm install -g @openai/codex@latest",
        executable: "npm",
        args: ["install", "-g", "@openai/codex@latest"],
        lockKey: "npm-global",
      },
    });
  });

  it.each([
    [
      "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
      "npm",
      ["install", "-g", "@openai/codex@latest"],
    ],
    ["/home/test/.bun/bin/codex", "bun", ["i", "-g", "@openai/codex@latest"]],
    ["/home/test/.local/share/pnpm/codex", "pnpm", ["add", "-g", "@openai/codex@latest"]],
    ["/home/test/.vite-plus/bin/codex", "vp", ["i", "-g", "@openai/codex"]],
    ["/opt/homebrew/bin/codex", "brew", ["upgrade", "codex"]],
  ])("retains the legacy %s-path selection below the boundary", (binaryPath, executable, args) => {
    expect(select("0.127.9", binaryPath).update).toMatchObject({
      executable,
      args,
    });
  });

  it("keeps an unrecognized explicit path manual-only below the boundary", () => {
    expect(select("0.127.9", "/custom/tools/codex").update).toBeNull();
  });

  it("uses codex update for an unrecognized explicit path at the boundary", () => {
    expect(select("0.128.0", "/custom/tools/codex").update).toMatchObject({
      command: "codex update",
      executable: "codex",
      args: ["update"],
    });
  });

  it("derives the displayed update command and availability from the selected capability", () => {
    expect(
      createProviderVersionAdvisory({
        driver: CODEX_DRIVER,
        currentVersion: "0.128.0",
        latestVersion: "0.129.0",
        maintenanceCapabilities: select("0.128.0", "/custom/tools/codex"),
      }),
    ).toMatchObject({
      updateCommand: "codex update",
      canUpdate: true,
    });

    expect(
      createProviderVersionAdvisory({
        driver: CODEX_DRIVER,
        currentVersion: "0.127.9",
        latestVersion: "0.129.0",
        maintenanceCapabilities: select("0.127.9", "/custom/tools/codex"),
      }),
    ).toMatchObject({
      updateCommand: null,
      canUpdate: false,
    });
  });
});
