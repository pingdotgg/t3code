import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { APP_NAME } from "@t3tools/shared/branding";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  checkEnvironmentUpdates,
  summarizeUpdateCheck,
  type UpdateCheckCommands,
  type UpdateCheckEnvironment,
} from "./updateCheck.ts";

function provider(
  driver: string,
  latestVersion: string | null,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-19T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: latestVersion === null ? "current" : "behind_latest",
      currentVersion: "1.0.0",
      latestVersion,
      updateCommand: null,
      canUpdate: false,
      checkedAt: null,
      message: null,
    },
    ...overrides,
  };
}

function environment(
  label: string,
  serverVersion: string | null,
  overrides: Partial<UpdateCheckEnvironment> = {},
): UpdateCheckEnvironment {
  return {
    environmentId: EnvironmentId.make(label),
    label,
    connection: { phase: "connected" },
    serverConfig:
      serverVersion === null
        ? null
        : ({
            environment: { serverVersion, capabilities: { npmReleaseLookup: true } },
          } as unknown as Pick<ServerConfig, "environment">),
    hostedByThisApp: false,
    canManageProviders: true,
    ...overrides,
  };
}

function commands(
  releases: Record<string, string>,
  providers: ReadonlyArray<ServerProvider>,
): UpdateCheckCommands {
  return {
    lookupNpmRelease: async ({ input }) =>
      AsyncResult.success(releases[input.spec] ? { version: releases[input.spec]! } : null),
    refreshProviders: async () => AsyncResult.success({ providers }),
  };
}

describe("checkEnvironmentUpdates", () => {
  it("compares each server with its own track and lists each provider update once", async () => {
    const items = await checkEnvironmentUpdates(
      [
        environment("nightly-box", "0.1.10-nightly.20261118.527001"),
        environment("stable-box", "0.1.10"),
        environment("this-app", "0.1.10", { hostedByThisApp: true }),
        environment("preview-box", "0.1.10-preview.20261118.1", { canManageProviders: false }),
        environment("offline", null, { connection: { phase: "offline" } }),
      ],
      commands({ nightly: "0.1.10-nightly.20261119.529001", latest: "0.1.10" }, [
        provider("codex", "0.9.0"),
        provider("codex", "0.9.0", { instanceId: ProviderInstanceId.make("codex-work") }),
        provider("claudeAgent", "3.0.0", {
          compatibilityAdvisory: { latestVersionStatus: "broken" } as never,
        }),
      ]),
    );

    expect(items).toEqual([
      {
        subject: `${APP_NAME} on nightly-box`,
        result: { status: "available", version: "0.1.10-nightly.20261119.529001" },
      },
      { subject: "Codex on nightly-box", result: { status: "available", version: "0.9.0" } },
      { subject: `${APP_NAME} on stable-box`, result: { status: "up-to-date" } },
      { subject: "Codex on stable-box", result: { status: "available", version: "0.9.0" } },
      { subject: "Codex on this-app", result: { status: "available", version: "0.9.0" } },
      {
        subject: `${APP_NAME} on preview-box`,
        result: { status: "error", reason: "Preview builds have no update track." },
      },
      {
        subject: "Providers on preview-box",
        result: { status: "error", reason: "You do not have permission to manage them." },
      },
      { subject: "offline", result: { status: "error", reason: "Not connected." } },
    ]);
  });

  it("reports a request that never answers instead of waiting on it", async () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    const check = checkEnvironmentUpdates([environment("studio", "0.1.10")], {
      lookupNpmRelease: async () => AsyncResult.success(null),
      refreshProviders: () => new Promise(() => {}),
      timeoutMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await check).toEqual([
      {
        subject: `${APP_NAME} on studio`,
        result: { status: "error", reason: "No stable release was found." },
      },
      {
        subject: "Providers on studio",
        result: { status: "error", reason: "No answer after 2 seconds." },
      },
    ]);
  });
});

describe("summarizeUpdateCheck", () => {
  it("leads with an available update, then a failure, and never reports nothing", () => {
    expect(summarizeUpdateCheck([]).tone).toBe("error");
    expect(
      summarizeUpdateCheck([
        { subject: "Providers on studio", result: { status: "error", reason: "offline" } },
        { subject: "Codex on studio", result: { status: "available", version: "0.9.0" } },
      ]),
    ).toEqual({
      tone: "available",
      title: "Updates available",
      lines: ["Providers on studio: offline", "Codex on studio: 0.9.0 available"],
    });
    expect(
      summarizeUpdateCheck([{ subject: "Providers on studio", result: { status: "up-to-date" } }])
        .title,
    ).toBe("Everything is up to date");
  });
});
