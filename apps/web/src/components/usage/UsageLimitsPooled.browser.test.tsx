import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { type LimitPresentations, CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import "../../index.css";
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

it("keeps the account label and reset summary on a one-account row of a multi-account provider", async () => {
  const now = Date.parse("2026-10-28T01:00:00.000Z");
  const checkedAt = new Date(now).toISOString();
  const driver = ProviderDriverKind.make("codex");
  const presentations: LimitPresentations = new Map([
    [
      EnvironmentId.make("demo"),
      {
        entry: { target: { label: "Demo" } },
        serverConfig: {
          providers: [],
          usageLimitSources: [
            {
              id: UsageLimitSourceId.make("demo"),
              kind: "cliproxy",
              label: "Demo",
              checkedAt,
              accounts: [
                {
                  id: "session-only",
                  driver,
                  usageLimits: {
                    checkedAt,
                    windows: [
                      {
                        id: "primary",
                        kind: "session",
                        label: "Session",
                        usedPercent: 0,
                        resetsAt: "2026-10-28T03:55:00.000Z",
                      },
                    ],
                  },
                },
                {
                  id: "later-session",
                  driver,
                  usageLimits: {
                    checkedAt,
                    windows: [
                      {
                        id: "primary",
                        kind: "session",
                        label: "Session",
                        usedPercent: 0.6,
                        resetsAt: "2026-10-28T05:00:00.000Z",
                      },
                    ],
                  },
                },
                {
                  id: "monthly-only",
                  driver,
                  usageLimits: {
                    checkedAt,
                    windows: [
                      {
                        id: "primary",
                        kind: "monthly",
                        label: "Monthly",
                        usedPercent: 2,
                        resetsAt: "2026-11-26T18:00:00.000Z",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  ]);
  const container = document.createElement("div");
  container.style.width = "1000px";
  await using screen = await render(
    <AppAtomRegistryProvider>
      <UsageLimitsPooled presentations={presentations} now={now} />
    </AppAtomRegistryProvider>,
    { container },
  );
  await expect.element(screen.getByText("monthly-only", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("Next account reset in 29d 17h")).toBeVisible();
  await expect.element(screen.getByText("Next account reset in 2h 55m")).toBeVisible();
  await expect.element(screen.getByText("average left", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Across 2 accounts", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: /^later-session: 99% left/ }).click();
  await expect.element(screen.getByText("100% left on this account")).toBeVisible();
});
