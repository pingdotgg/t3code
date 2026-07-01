import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

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

  it("accepts provider snapshots with usage limits", () => {
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
      usageLimits: {
        source: "codexAppServer",
        available: true,
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [
          {
            kind: "session",
            label: "Session",
            usedPercent: 42,
            windowDurationMins: 300,
            resetsAt: "2026-04-10T05:00:00.000Z",
          },
        ],
      },
    });

    expect(parsed.usageLimits?.available).toBe(true);
    expect(parsed.usageLimits?.windows).toHaveLength(1);
  });

  it("accepts unavailable usage limit snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      usageLimits: {
        source: "claudeStatusProbe",
        available: false,
        reason: "Usage limits unavailable for this account.",
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [],
      },
    });

    expect(parsed.usageLimits).toEqual({
      source: "claudeStatusProbe",
      available: false,
      reason: "Usage limits unavailable for this account.",
      checkedAt: "2026-04-10T00:00:00.000Z",
      windows: [],
    });
  });

  it("accepts cursor and opencode usage limit sources", () => {
    const cursorParsed = decodeServerProvider({
      instanceId: "cursor",
      driver: "cursor",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      usageLimits: {
        source: "cursorAcp",
        available: false,
        reason: "Cursor does not expose subscription usage",
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [],
      },
    });
    const openCodeParsed = decodeServerProvider({
      instanceId: "opencode",
      driver: "opencode",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      usageLimits: {
        source: "opencodeManaged",
        available: false,
        reason: "Unable to fetch usage",
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [],
      },
    });

    expect(cursorParsed.usageLimits?.source).toBe("cursorAcp");
    expect(cursorParsed.usageLimits?.available).toBe(false);
    expect(openCodeParsed.usageLimits?.source).toBe("opencodeManaged");
  });

  it("accepts grok usage limit sources", () => {
    const parsed = decodeServerProvider({
      instanceId: "grok",
      driver: "grok",
      enabled: true,
      installed: true,
      version: "0.2.59",
      status: "ready",
      auth: {
        status: "authenticated",
        email: "user@example.com",
        type: "SuperGrok",
        label: "SuperGrok",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      usageLimits: {
        source: "grokAcp",
        available: false,
        reason: "Grok does not expose subscription usage",
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [],
      },
    });

    expect(parsed.usageLimits?.source).toBe("grokAcp");
    expect(parsed.usageLimits?.available).toBe(false);
  });

  it("rejects invalid usage percentages", () => {
    expect(() =>
      decodeServerProvider({
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
        usageLimits: {
          source: "codexAppServer",
          available: true,
          checkedAt: "2026-04-10T00:00:00.000Z",
          windows: [
            {
              kind: "session",
              label: "Session",
              usedPercent: 101,
            },
          ],
        },
      }),
    ).toThrow();
  });
});
