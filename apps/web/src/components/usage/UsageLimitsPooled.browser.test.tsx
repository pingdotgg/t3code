import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

function claude(instanceId: string, displayName: string, weeklyUsed: number, resetsAt: string) {
  return {
    ...managedChatGpt(instanceId, displayName),
    driver: ProviderDriverKind.make("claudeAgent"),
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "seven_day",
          kind: "weekly" as const,
          label: "Weekly",
          usedPercent: weeklyUsed,
          resetsAt,
          windowDurationMins: 7 * 24 * 60,
        },
      ],
    },
  } satisfies ServerProvider;
}

describe("UsageLimitsPooled pooled quota", () => {
  it("adds the accounts into one pool and projects when it runs out", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              claude("claude_a", "Auto", 68, "2026-10-27T12:00:00.000Z"),
              claude("claude_b", "Auto B", 27, "2026-10-31T13:00:00.000Z"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect.element(screen.getByText("105%", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("of 200%")).toBeVisible();
    await expect.element(screen.getByText("Pool empty")).toBeVisible();
    await expect.element(screen.getByText("Burn, window avg")).toBeVisible();
    await expect
      .element(
        screen.getByRole("img", { name: "Weekly: pooled quota left, recorded and projected" }),
      )
      .toBeVisible();
  });
});
