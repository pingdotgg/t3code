import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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

describe("UsageLimitsPooled account popover", () => {
  it("exposes each detail as its own label and value to screen readers", async () => {
    const now = "2026-11-12T14:00:00.000Z";
    const claude: ServerProvider = {
      ...managedChatGpt("claude", "Claude"),
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: { status: "authenticated", label: "Claude Pro Subscription" },
      usageLimits: {
        checkedAt: now,
        windows: [
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 0,
            resetsAt: "2026-11-18T12:00:00.000Z",
            windowDurationMins: 10_080,
          },
        ],
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        { entry: { target: { label: "Desk" } }, serverConfig: { providers: [claude] } },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(now)} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /% left/ }));
    const popover = page.getByRole("dialog");
    for (const [label, value] of [
      ["Plan", "Claude Pro Subscription"],
      ["Signed in", "Desk"],
      ["Left", "100%"],
    ] as const) {
      await expect
        .element(popover.getByRole("term").getByText(label, { exact: true }))
        .toBeVisible();
      await expect
        .element(popover.getByRole("definition").getByText(value, { exact: true }))
        .toBeVisible();
    }
  });
});
