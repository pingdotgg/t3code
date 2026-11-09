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

describe("UsageLimitsPooled reset credits", () => {
  it("advertises a model-scoped reset only on the windows it clears", async () => {
    const resetCredits = {
      availableCount: 1,
      nextExpiresAt: "2026-11-17T07:59:00.000Z",
      nextCreditId: "launch-2610-fable-week",
      grants: [
        {
          id: "launch-2610-fable-week",
          count: 1,
          expiresAt: "2026-11-17T07:59:00.000Z",
          clearsWindowIds: ["five_hour", "seven_day_fable"],
        },
      ],
    };
    const claude: ServerProvider = {
      ...managedChatGpt("claude_work", "Claude Work"),
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: { status: "authenticated", email: "dev@example.com" },
      usageLimits: {
        checkedAt,
        windows: [
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 59 },
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 93 },
          { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 3 },
        ],
        resetCredits,
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        { entry: { target: { label: "Desk" } }, serverConfig: { providers: [claude] } },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByRole("button", { name: /^Claude Work: 41% left/ }))
      .toHaveAccessibleName("Claude Work: 41% left, 1 reset credit banked");
    await expect
      .element(screen.getByRole("button", { name: /^Claude Work: 97% left/ }))
      .toHaveAccessibleName("Claude Work: 97% left, 1 reset credit banked");
    await expect
      .element(screen.getByRole("button", { name: /^Claude Work: 7% left/ }))
      .toHaveAccessibleName("Claude Work: 7% left");
  });
});

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
