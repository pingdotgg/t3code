import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
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
      <UsageLimitsPooled
        presentations={presentations}
        now={Date.parse(checkedAt)}
        display="left"
        hideEmails={false}
      />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

describe("UsageLimitsPooled reset credits", () => {
  it.each([false, true])("offers each kind of credit once per account (hub: %s)", async (hub) => {
    const claude: ServerProvider = {
      ...managedChatGpt("claude_work", "Claude Work"),
      driver: ProviderDriverKind.make("claudeAgent"),
      usageLimits: {
        checkedAt,
        windows: [
          {
            id: "session",
            kind: "session",
            label: "Session",
            usedPercent: 100,
            resetsAt: checkedAt,
          },
          { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 70 },
          { id: "fable", kind: "weekly", label: "Fable", usedPercent: 90 },
        ],
        resetCredits: {
          availableCount: 3,
          nextCreditId: "hub-credit",
          options: [
            {
              creditId: "grant-weekly",
              label: "Weekly reset",
              description: "Refills your weekly limit.",
              availableCount: 1,
            },
            {
              creditId: "grant-fable",
              label: "Fable reset",
              description: "Refills your Fable allowance.",
              availableCount: 2,
            },
          ],
        },
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: hub
            ? {
                providers: [],
                usageLimitSources: [
                  {
                    id: UsageLimitSourceId.make("hub"),
                    kind: "cliproxy" as const,
                    label: "Hub",
                    checkedAt,
                    accounts: [
                      { id: "claude", driver: claude.driver, usageLimits: claude.usageLimits! },
                    ],
                  },
                ],
              }
            : { providers: [claude] },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled
        presentations={presentations}
        now={Date.parse(checkedAt)}
        display="left"
        hideEmails={false}
      />,
    );

    const weekly = screen.getByRole("button", { name: /^Use Weekly reset · 1 left/ });
    const fable = screen.getByRole("button", { name: /^Use Fable reset · 2 left/ });
    await expect.element(weekly).toBeVisible();
    await expect.element(fable).toBeVisible();
    expect(weekly.elements()).toHaveLength(1);
    expect(fable.elements()).toHaveLength(1);
    await expect.element(screen.getByText("resets now", { exact: true })).toBeVisible();
    if (!hub) {
      const exhausted = {
        ...claude,
        usageLimits: {
          ...claude.usageLimits!,
          windows: [
            { id: "session", kind: "session" as const, label: "Session", usedPercent: 100 },
            {
              id: "weekly",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: 100,
              resetsAt: "2026-10-26T16:00:00.000Z",
            },
            { id: "fable", kind: "weekly" as const, label: "Fable", usedPercent: 20 },
          ],
        },
      };
      const updated = new Map([
        [
          EnvironmentId.make("desk"),
          { entry: { target: { label: "Desk" } }, serverConfig: { providers: [exhausted] } },
        ],
      ]);
      await screen.rerender(
        <UsageLimitsPooled
          presentations={updated}
          now={Date.parse(checkedAt)}
          display="left"
          hideEmails={false}
        />,
      );
      await expect.element(screen.getByRole("img", { name: /^Fable: 80% left/ })).toBeVisible();
      const spent = {
        ...exhausted,
        usageLimits: {
          ...exhausted.usageLimits,
          windows: exhausted.usageLimits.windows.slice(0, 2),
        },
      };
      updated.set(EnvironmentId.make("desk"), {
        entry: { target: { label: "Desk" } },
        serverConfig: { providers: [spent] },
      });
      await screen.rerender(
        <UsageLimitsPooled
          presentations={updated}
          now={Date.parse(checkedAt)}
          display="left"
          hideEmails={false}
        />,
      );
      await expect.element(screen.getByText("Out of usage", { exact: true })).toBeVisible();
      expect(screen.getByText(/· back/).elements()).toHaveLength(0);
    }
    if (hub) {
      await expect.element(weekly).toBeDisabled();
      await expect.element(fable).toBeDisabled();
      await expect
        .element(screen.getByRole("button", { name: /^Use Reset credit · 3 left/ }))
        .toBeVisible();
    }
  });
});
