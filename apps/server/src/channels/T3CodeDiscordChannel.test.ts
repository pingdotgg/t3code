import { expect, it } from "@effect/vitest";
import {
  DiscordChannelSettings,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import {
  assistantResponseText,
  channelBranchName,
  createDiscordTextClient,
  discordModelOptions,
  isDiscordChannelConfigured,
  resolveDiscordModel,
  taskStatusText,
} from "./T3CodeDiscordChannel.ts";

const decodeDiscordChannelSettings = Schema.decodeSync(DiscordChannelSettings);

const configuredDiscord = {
  enabled: true,
  projectId: ProjectId.make("project-1"),
  modelSelection: null,
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
    const defaults = decodeDiscordChannelSettings({});
    expect(defaults.threadEnvMode).toBe("worktree");
    expect(defaults.modelSelection).toBeNull();
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

  it("renders one plain-text status that can be edited as a task progresses", () => {
    const task = {
      threadId: ThreadId.make("thread-1"),
      title: "Fix login",
      branch: null,
      threadEnvMode: "local",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      state: "running",
      assistantResponse: null,
    } as const;

    expect(taskStatusText(task)).toBe("Fix login 🔄");
    expect(
      taskStatusText({
        ...task,
        state: "done",
        assistantResponse: "Fixed the login flow and added coverage.",
      }),
    ).toBe("Fix login ✅\n\nFixed the login flow and added coverage.");
    expect(taskStatusText(task)).not.toContain("Model:");
    expect(taskStatusText(task)).not.toContain("Target:");
  });

  it("uses the final assistant message as the completed Discord response", () => {
    expect(
      assistantResponseText({
        assistantMessageId: "assistant-final",
        turnId: "turn-1",
        messages: [
          { id: "assistant-progress", role: "assistant", text: "Working", turnId: "turn-1" },
          {
            id: "assistant-final",
            role: "assistant",
            text: "  The requested change is complete.  ",
            turnId: "turn-1",
          },
        ],
      }),
    ).toBe("The requested change is complete.");
  });

  it("sends and edits native Discord content without Channels UI components", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      requests.push({ url: requestUrl, ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify(
          requestUrl.endsWith("/users/@me") && init?.method === "GET"
            ? { username: "copilotkit-ad" }
            : { id: "message-1" },
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
    const client = createDiscordTextClient("secret", fetchImpl);

    const ref = await client.post("channel-1", "Queued");
    await client.update(ref, "Running");
    await client.ensureBotUsername("copilot");
    await client.setGuildNickname("guild-1", "copilot");

    expect(requests.map(({ init }) => init?.method)).toEqual([
      "POST",
      "PATCH",
      "GET",
      "PATCH",
      "PATCH",
    ]);
    expect(requests[1]?.url).toContain("/channels/channel-1/messages/message-1");
    expect(requests[3]?.url).toContain("/users/@me");
    expect(requests[4]?.url).toContain("/guilds/guild-1/members/@me");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      content: "Queued",
    });
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({ username: "copilot" });
    expect(JSON.parse(String(requests[4]?.init?.body))).toEqual({ nick: "copilot" });
  });
});
