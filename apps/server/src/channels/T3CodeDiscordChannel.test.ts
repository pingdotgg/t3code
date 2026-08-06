import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { describe } from "vite-plus/test";

import { channelBranchName, isDiscordChannelConfigured } from "./T3CodeDiscordChannel.ts";

const configuredDiscord = {
  enabled: true,
  projectId: ProjectId.make("project-1"),
  baseBranch: "main",
  branchPrefix: "demo/discord",
  applicationId: "app-1",
  guildId: "guild-1",
  botToken: "token",
  botTokenRedacted: true,
} as const;

describe("Discord channel isolation", () => {
  it("creates a unique task branch below the configured prefix", () => {
    expect(
      channelBranchName({
        prefix: "/demo/discord/",
        prompt: "Fix the flaky login test!",
        suffix: "a1b2c3d4",
      }),
    ).toBe("demo/discord/fix-the-flaky-login-test-a1b2c3d4");
  });

  it("never resolves a task branch to main", () => {
    expect(
      channelBranchName({ prefix: "demo/discord", prompt: "main", suffix: "12345678" }),
    ).not.toBe("main");
  });

  it("refuses to start without an isolated branch prefix", () => {
    expect(isDiscordChannelConfigured({ ...configuredDiscord, branchPrefix: "" })).toBe(false);
  });

  it("refuses to start while the integration is disabled", () => {
    expect(isDiscordChannelConfigured({ ...configuredDiscord, enabled: false })).toBe(false);
  });
});
