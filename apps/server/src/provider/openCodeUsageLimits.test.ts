import { describe, expect, it } from "vitest";

import { resolveOpenCodeManagedUsageLimits } from "./openCodeUsageLimits.ts";

describe("resolveOpenCodeManagedUsageLimits", () => {
  it("returns one managed usage window for opencode-go", () => {
    expect(
      resolveOpenCodeManagedUsageLimits({
        checkedAt: "2026-04-18T00:00:00.000Z",
        inventory: {
          providerList: {
            connected: ["opencode-go"],
            default: {},
            all: [
              {
                id: "opencode-go",
                name: "OpenCode Go",
                env: [],
                models: {},
                usage: {
                  usedPercent: 32,
                },
              },
            ],
          },
          agents: [],
        } as never,
      }),
    ).toEqual({
      source: "opencodeManaged",
      available: true,
      checkedAt: "2026-04-18T00:00:00.000Z",
      windows: [{ kind: "session", label: "OpenCode Go", usedPercent: 32 }],
    });
  });

  it("returns both managed usage windows when both subscriptions expose real usage", () => {
    const result = resolveOpenCodeManagedUsageLimits({
      checkedAt: "2026-04-18T00:00:00.000Z",
      inventory: {
        providerList: {
          connected: ["opencode-go", "opencode-zen"],
          default: {},
          all: [
            {
              id: "opencode-go",
              name: "OpenCode Go",
              env: [],
              models: {},
              usage: { usedPercent: 10 },
            },
            {
              id: "opencode-zen",
              name: "OpenCode Zen",
              env: [],
              models: {},
              usage: { used: 45, limit: 90 },
            },
          ],
        },
        agents: [],
      } as never,
    });

    expect(result?.windows).toEqual([
      { kind: "session", label: "OpenCode Go", usedPercent: 10 },
      { kind: "session", label: "OpenCode Zen", usedPercent: 50 },
    ]);
  });

  it("ignores non-managed and malformed usage sources", () => {
    expect(
      resolveOpenCodeManagedUsageLimits({
        checkedAt: "2026-04-18T00:00:00.000Z",
        inventory: {
          providerList: {
            connected: ["anthropic", "opencode-go"],
            default: {},
            all: [
              {
                id: "anthropic",
                name: "Anthropic",
                env: [],
                models: {},
                usage: { usedPercent: 99 },
              },
              {
                id: "opencode-go",
                name: "OpenCode Go",
                env: [],
                models: {},
                usage: { used: 10, limit: 0 },
              },
            ],
          },
          agents: [],
        } as never,
      }),
    ).toBeUndefined();
  });
});
