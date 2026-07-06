import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ServerProvider,
  ServerProviderProjectCapabilitiesError,
  ServerProviderProjectCapabilitiesInput,
  ServerProviderProjectCapabilitiesResult,
} from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeProjectCapabilitiesInput = Schema.decodeUnknownSync(
  ServerProviderProjectCapabilitiesInput,
);
const decodeProjectCapabilitiesResult = Schema.decodeUnknownSync(
  ServerProviderProjectCapabilitiesResult,
);
const decodeProjectCapabilitiesError = Schema.decodeUnknownSync(
  ServerProviderProjectCapabilitiesError,
);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("preserves exact project capability cwd values", () => {
    const input = decodeProjectCapabilitiesInput({
      providerInstanceId: "codex",
      cwd: "/repo/with-space ",
    });
    const result = decodeProjectCapabilitiesResult({
      providerInstanceId: "codex",
      cwd: " /repo/with-leading-space",
    });
    const error = decodeProjectCapabilitiesError({
      _tag: "ServerProviderProjectCapabilitiesError",
      providerInstanceId: "codex",
      cwd: "/repo/with-space ",
      message: "Failed to load project capabilities.",
    });

    expect(input.cwd).toBe("/repo/with-space ");
    expect(result.cwd).toBe(" /repo/with-leading-space");
    expect(error.cwd).toBe("/repo/with-space ");
    expect(() =>
      decodeProjectCapabilitiesInput({
        providerInstanceId: "codex",
        cwd: "   ",
      }),
    ).toThrow();
  });
});
