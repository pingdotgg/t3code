import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { claudePlatformKey, planRuntimeUpdate, providerIsOutdated } from "./runtimePlan.ts";

const auto = { mode: "auto" as const, updateUserInstalls: false };
type PlanProvider = Parameters<typeof planRuntimeUpdate>[0]["provider"];
const provider = (overrides: Record<string, unknown> = {}): PlanProvider =>
  ({
    driver: ProviderDriverKind.make("claudeAgent"),
    installed: true,
    enabled: true,
    versionAdvisory: {
      status: "behind_latest" as const,
      currentVersion: "2.1.223",
      latestVersion: "2.1.325",
      updateCommand: null,
      canUpdate: false,
    },
    ...overrides,
  }) as PlanProvider;
const managed = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  version: "2.1.300",
  executablePath: "/data/tools/claude/2.1.300/claude",
  previousBinaryPath: "",
  updatedAt: "",
};

describe("planRuntimeUpdate", () => {
  it("moves an outdated system install to a managed runtime without touching it", () => {
    expect(
      planRuntimeUpdate({
        provider: provider(),
        binaryPath: "",
        managed: undefined,
        settings: auto,
      }),
    ).toEqual({
      kind: "use-managed",
      driver: "claudeAgent",
    });
    expect(
      planRuntimeUpdate({
        provider: provider(),
        binaryPath: "claude",
        managed: undefined,
        settings: auto,
      }).kind,
    ).toBe("use-managed");
  });

  it("leaves custom binaries, current installs, and other settings alone", () => {
    const plan = (overrides: Partial<Parameters<typeof planRuntimeUpdate>[0]>) =>
      planRuntimeUpdate({
        provider: provider(),
        binaryPath: "",
        managed: undefined,
        settings: auto,
        ...overrides,
      }).kind;
    expect(plan({ binaryPath: "/opt/claude/bin/claude" })).toBe("none");
    expect(plan({ provider: provider({ versionAdvisory: undefined }) })).toBe("none");
    expect(plan({ settings: { mode: "notify", updateUserInstalls: true } })).toBe("none");
    expect(plan({ provider: provider({ enabled: false }) })).toBe("none");
    expect(plan({ provider: provider({ driver: ProviderDriverKind.make("opencode") }) })).toBe(
      "none",
    );
  });

  it("updates the user's own install in place only when allowed", () => {
    const updatable = provider({
      versionAdvisory: { ...provider().versionAdvisory, canUpdate: true },
    });
    expect(
      planRuntimeUpdate({ provider: updatable, binaryPath: "", managed: undefined, settings: auto })
        .kind,
    ).toBe("use-managed");
    expect(
      planRuntimeUpdate({
        provider: updatable,
        binaryPath: "",
        managed: undefined,
        settings: { mode: "auto", updateUserInstalls: true },
      }).kind,
    ).toBe("in-place-update");
  });

  it("refreshes a managed runtime only while Continuum still owns the path", () => {
    expect(
      planRuntimeUpdate({
        provider: provider(),
        binaryPath: managed.executablePath,
        managed,
        settings: auto,
      }).kind,
    ).toBe("refresh-managed");
    expect(
      planRuntimeUpdate({
        provider: provider(),
        binaryPath: "/usr/bin/claude",
        managed,
        settings: auto,
      }).kind,
    ).toBe("none");
  });

  it("treats hidden newer models as outdated", () => {
    expect(
      providerIsOutdated({
        updateRequiredModels: [
          { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", minVersion: "0.155.0" },
        ] as never,
      }),
    ).toBe(true);
  });
});

describe("claudePlatformKey", () => {
  it("matches Claude Code's release manifest keys", () => {
    expect(claudePlatformKey({ platform: "linux", arch: "x64", musl: false })).toBe("linux-x64");
    expect(claudePlatformKey({ platform: "linux", arch: "arm64", musl: true })).toBe(
      "linux-arm64-musl",
    );
    expect(claudePlatformKey({ platform: "win32", arch: "x64", musl: false })).toBe("win32-x64");
    expect(claudePlatformKey({ platform: "darwin", arch: "arm64", musl: false })).toBe(
      "darwin-arm64",
    );
    expect(claudePlatformKey({ platform: "freebsd", arch: "x64", musl: false })).toBeNull();
  });
});
