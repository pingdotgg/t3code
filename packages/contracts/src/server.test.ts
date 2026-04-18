import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding legacy snapshots", () => {
    const parsed = decodeServerProvider({
      provider: "codex",
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
  });

  it("accepts provider snapshots with usage limits", () => {
    const parsed = decodeServerProvider({
      provider: "codex",
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
      provider: "claudeAgent",
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
      provider: "cursor",
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
        available: true,
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [{ kind: "session", label: "Session", usedPercent: 12 }],
      },
    });
    const openCodeParsed = decodeServerProvider({
      provider: "opencode",
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
    expect(openCodeParsed.usageLimits?.source).toBe("opencodeManaged");
  });

  it("rejects invalid usage percentages", () => {
    expect(() =>
      decodeServerProvider({
        provider: "codex",
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
