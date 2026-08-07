import { expect, it } from "@effect/vitest";
import {
  DiscordChannelSettings,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import {
  channelBranchName,
  discordModelOptions,
  isDiscordChannelConfigured,
  resolveDiscordModel,
} from "./T3CodeDiscordChannel.ts";

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

describe("Discord channel model selection", () => {
  const provider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    availability: "available",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-07T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        isLegacy: true,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;

  it("offers current models from runnable provider instances", () => {
    expect(discordModelOptions([provider])).toEqual([
      {
        value: "codex/gpt-5.6-sol",
        label: "Codex · GPT-5.6 Sol",
        selection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
      },
    ]);
    expect(
      discordModelOptions([{ ...provider, auth: { status: "unauthenticated" } } as ServerProvider]),
    ).toEqual([]);
  });

  it("routes the selected Discord value to the exact provider and model", () => {
    const models = discordModelOptions([provider]);
    expect(resolveDiscordModel(models, "codex/gpt-5.6-sol")?.selection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    });
    expect(resolveDiscordModel(models, "codex/missing")).toBeUndefined();
  });
});
