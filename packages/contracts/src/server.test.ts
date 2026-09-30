import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerProvider, ServerProviderListCommandsInput } from "./server.ts";
import { providerSlashCommandArgumentError } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProviderListCommandsInput = Schema.decodeUnknownSync(
  ServerProviderListCommandsInput,
);

describe("provider slash command arguments", () => {
  it("enforces declared rules while keeping legacy commands unrestricted", () => {
    expect(providerSlashCommandArgumentError({ name: "copy", argumentMode: "none" }, "extra")).toBe(
      "/copy does not accept arguments.",
    );
    expect(
      providerSlashCommandArgumentError({ name: "copy", argumentMode: "none" }, " \n"),
    ).toBeNull();
    expect(providerSlashCommandArgumentError({ name: "run", argumentMode: "required" }, " ")).toBe(
      "/run requires arguments.",
    );
    expect(
      providerSlashCommandArgumentError({ name: "run", argumentMode: "required" }, "task"),
    ).toBeNull();
    expect(
      providerSlashCommandArgumentError({ name: "export", argumentMode: "optional" }, ""),
    ).toBeNull();
    expect(providerSlashCommandArgumentError({ name: "legacy" }, "extra")).toBeNull();
  });
});

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
});

describe("ServerProviderListCommandsInput", () => {
  it("accepts Copilot project command lookup requests", () => {
    expect(
      decodeServerProviderListCommandsInput({
        provider: "copilot",
        cwd: "/repo/project",
      }),
    ).toEqual({
      provider: "copilot",
      cwd: "/repo/project",
    });
  });
});
