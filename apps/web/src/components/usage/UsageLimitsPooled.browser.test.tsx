import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser";

import "../../index.css";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { USAGE_LIMIT_LAYOUT_KEY } from "./usageLimitLayout";

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

function isolatedLayoutStorage() {
  const saved = window.localStorage.getItem(USAGE_LIMIT_LAYOUT_KEY);
  window.localStorage.removeItem(USAGE_LIMIT_LAYOUT_KEY);
  return {
    [Symbol.dispose]() {
      if (saved === null) window.localStorage.removeItem(USAGE_LIMIT_LAYOUT_KEY);
      else window.localStorage.setItem(USAGE_LIMIT_LAYOUT_KEY, saved);
    },
  };
}

describe("UsageLimitsPooled", () => {
  it("arranges limits inline and restores hidden providers without losing collapsed state", async () => {
    using _storage = isolatedLayoutStorage();
    const weekly: ServerProviderUsageWindow = {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 40,
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("test-hub"),
                kind: "cliproxy" as const,
                label: "Hub",
                checkedAt,
                accounts: [
                  {
                    id: "codex",
                    driver: ProviderDriverKind.make("codex"),
                    usageLimits: {
                      checkedAt,
                      windows: [
                        weekly,
                        { ...weekly, id: "session", kind: "session" as const, label: "Session" },
                      ],
                    },
                  },
                  {
                    id: "gemini",
                    driver: ProviderDriverKind.make("antigravity"),
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...weekly, id: "gemini-weekly", label: "Gemini · Weekly" }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );
    expect(screen.getByRole("button", { name: "Customize limits" }).elements()).toHaveLength(0);
    const collapse = screen.getByRole("button", { name: "Collapse Codex limits" });
    const collapseIndicator = collapse
      .element()
      .querySelector<SVGSVGElement>(".lucide-chevron-right")!;
    await expect.element(collapseIndicator).toHaveStyle({ opacity: "0" });
    collapse.element().focus();
    await expect.element(collapse).toHaveFocus();
    await expect.element(collapseIndicator).toHaveStyle({ opacity: "1" });
    collapse.element().blur();
    await expect.element(collapseIndicator).toHaveStyle({ opacity: "0" });
    await collapse.hover();
    await expect.element(collapseIndicator).toHaveStyle({ opacity: "1" });
    await screen.getByRole("button", { name: "Collapse Codex limits" }).click();
    await expect.element(screen.getByText("Session", { exact: true })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Expand Codex limits" }).click();
    screen.getByRole("button", { name: "Collapse Codex limits" }).element().blur();
    await commands.resetPointer();
    expect(screen.getByRole("dialog").elements()).toHaveLength(0);
    const providerReorder = screen
      .getByRole("button", { name: "Move Codex down", exact: true })
      .element().parentElement!.parentElement!;
    const windowReorder = screen
      .getByRole("button", { name: "Move Codex Weekly up", exact: true })
      .element().parentElement!.parentElement!;
    await expect.element(providerReorder).toHaveStyle({ opacity: "0" });
    await expect.element(windowReorder).toHaveStyle({ opacity: "0" });
    await screen.getByRole("heading", { name: /Codex/ }).hover();
    await expect.element(providerReorder).toHaveStyle({ opacity: "1" });
    await expect.element(windowReorder).toHaveStyle({ opacity: "0" });
    await screen.getByText("Weekly", { exact: true }).hover();
    await expect.element(windowReorder).toHaveStyle({ opacity: "1" });
    await expect.element(providerReorder).toHaveStyle({ opacity: "0" });
    await commands.resetPointer();
    await expect.element(providerReorder).toHaveStyle({ opacity: "0" });
    await expect.element(screen.getByText("Session", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Hide Codex Weekly", exact: true }).click();
    await expect.element(screen.getByText("Weekly", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Show hidden limits" })).toHaveFocus();
    await screen.getByRole("button", { name: "Show hidden limits" }).click();
    await screen.getByRole("button", { name: "Show Codex Weekly", exact: true }).click();
    await screen.getByRole("button", { name: "Hide hidden limits" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Collapse Codex limits" }))
      .toHaveFocus();
    const moveProviderDown = screen.getByRole("button", { name: "Move Codex down", exact: true });
    moveProviderDown.element().focus();
    await expect.element(providerReorder).toHaveStyle({ opacity: "1" });
    await userEvent.keyboard("{Enter}");
    await expect.element(moveProviderDown).toHaveFocus();
    await expect.element(moveProviderDown).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("heading", { level: 2 }).first())
      .toHaveTextContent("Antigravity");
    const moveWeeklyUp = screen.getByRole("button", { name: "Move Codex Weekly up", exact: true });
    moveWeeklyUp.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(moveWeeklyUp).toHaveFocus();
    await expect.element(moveWeeklyUp).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    await screen.getByRole("button", { name: "Collapse Codex limits" }).click();
    await screen.getByRole("button", { name: "Hide Codex", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: /Codex/ })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Show hidden limits" }).click();
    await screen.getByRole("button", { name: "Show Codex", exact: true }).click();
    await screen.getByRole("button", { name: "Hide hidden limits" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Expand Codex limits" }))
      .toHaveAttribute("aria-expanded", "false");
    await screen.rerender(
      <UsageLimitsPooled
        key="reopened"
        presentations={presentations}
        now={Date.parse(checkedAt)}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Expand Codex limits" }))
      .toHaveAttribute("aria-expanded", "false");
    await screen.getByRole("button", { name: "Expand Codex limits" }).click();
    await expect.element(screen.getByText("Session", { exact: true })).toBeVisible();

    await screen.getByRole("button", { name: "Reset layout" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Collapse Codex limits" }))
      .toHaveFocus();
    await expect
      .element(screen.getByRole("heading", { level: 2 }).first())
      .toHaveTextContent("Codex");
  });

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
