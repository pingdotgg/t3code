import { expect, it } from "@effect/vitest";
import { DiscordChannelSettings, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { channelBranchName, isDiscordChannelConfigured } from "./T3CodeDiscordChannel.ts";

const decodeDiscordChannelSettings = Schema.decodeSync(DiscordChannelSettings);

const configuredDiscord = {
  enabled: true,
  projectId: ProjectId.make("project-1"),
  threadEnvMode: "worktree",
  baseBranch: "main",
  branchPrefix: "demo/discord",
  applicationId: "app-1",
  guildId: "guild-1",
  botToken: "token",
  botTokenRedacted: true,
} as const;

describe("Discord channel isolation", () => {
  it("keeps isolated worktrees as the default for existing settings", () => {
    expect(decodeDiscordChannelSettings({}).threadEnvMode).toBe("worktree");
  });

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

  it("does not require branch settings when tasks run in the project checkout", () => {
    expect(
      isDiscordChannelConfigured({
        ...configuredDiscord,
        threadEnvMode: "local",
        baseBranch: "",
        branchPrefix: "",
      }),
    ).toBe(true);
  });

  it("refuses to start while the integration is disabled", () => {
    expect(isDiscordChannelConfigured({ ...configuredDiscord, enabled: false })).toBe(false);
  });
});
