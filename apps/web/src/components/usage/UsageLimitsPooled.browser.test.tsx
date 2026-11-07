import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import "~/index.css";

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

describe("UsageLimitsPooled pool bar", () => {
  it("labels a single account's bar in the wide layout", async () => {
    await page.viewport(1280, 800);
    const codex: ServerProvider = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "0.164.0",
      status: "ready",
      auth: { status: "authenticated", email: "kam@example.com" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt,
        windows: [
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 40,
            resetsAt: "2026-10-28T16:00:00.000Z",
          },
        ],
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        { entry: { target: { label: "Desk" } }, serverConfig: { providers: [codex] } },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    const bar = screen.getByRole("button", { name: /^KE: 60% left/ });
    await expect.element(bar.getByText("↻ 3d 0h")).toBeVisible();
    await expect.element(bar.getByText("KE", { exact: true })).toBeVisible();
  });
});
