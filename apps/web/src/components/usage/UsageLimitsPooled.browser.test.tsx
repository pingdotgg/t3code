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
import { cdp, commands, page, userEvent } from "vite-plus/test/browser";

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

async function dragHandle(source: HTMLElement | SVGElement, target: HTMLElement | SVGElement) {
  await userEvent.hover(source.closest<HTMLElement>(".group\\/limit-row")!);
  await userEvent.hover(source);
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const frame = window.frameElement?.getBoundingClientRect();
  const x = from.x + from.width / 2 + (frame?.x ?? 0);
  const y = from.y + from.height / 2 + (frame?.y ?? 0);
  const endY = to.y + to.height / 2 + (frame?.y ?? 0);
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  try {
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y + 8, buttons: 1 });
    await expect.element(source).toHaveAttribute("aria-pressed", "true");
    for (let step = 1; step <= 8; step++) {
      await cdp().send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y: y + ((endY - y) * step) / 8,
        buttons: 1,
      });
    }
  } finally {
    await cdp().send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y: endY,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }
}

describe("UsageLimitsPooled", () => {
  it("arranges limits inline and restores hidden providers without losing collapsed state", async () => {
    using _storage = isolatedLayoutStorage();
    await page.viewport(1000, 1000);
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
    const collapseIndicator = collapse.element().parentElement!;
    await expect.element(collapseIndicator).toHaveStyle({ opacity: "0" });
    collapse.element().focus();
    await expect.element(collapse).toHaveFocus();
    await expect.element(collapseIndicator).toHaveStyle({ opacity: "1" });
    collapse.element().blur();
    await expect.element(collapseIndicator).toHaveStyle({ opacity: "0" });
    await screen.getByRole("heading", { name: /Codex/ }).hover();
    await expect.element(collapseIndicator).toHaveStyle({ opacity: "1" });
    await screen.getByRole("button", { name: "Collapse Codex limits" }).click();
    await expect.element(screen.getByText("Session", { exact: true })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Expand Codex limits" }).click();
    screen.getByRole("button", { name: "Collapse Codex limits" }).element().blur();
    await commands.resetPointer();
    expect(screen.getByRole("dialog").elements()).toHaveLength(0);
    const providerReorder = screen
      .getByRole("button", { name: "Reorder Codex", exact: true })
      .element().parentElement!;
    const windowReorder = screen
      .getByRole("button", { name: "Reorder Codex Weekly", exact: true })
      .element().parentElement!;
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
    expect(screen.getByRole("button", { name: /Antigravity Gemini/ }).elements()).toHaveLength(0);
    await screen.getByText("Weekly", { exact: true }).hover();
    await screen.getByRole("button", { name: "Hide Codex Weekly", exact: true }).click();
    await expect.element(screen.getByText("Weekly", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "1 item hidden" })).toHaveFocus();
    await screen.getByRole("button", { name: "1 item hidden" }).click();
    await screen.getByRole("button", { name: "Show Codex Weekly", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "1 item hidden" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Collapse Codex limits" }))
      .toHaveFocus();
    await screen.getByRole("heading", { name: /Antigravity/ }).hover();
    await screen.getByRole("button", { name: "Hide Antigravity", exact: true }).click();
    await expect.element(screen.getByText("Gemini · Weekly")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "1 item hidden" }).click();
    await expect.element(screen.getByText("Gemini · Weekly")).toBeVisible();
    const revealedSegment = screen.getByRole("button", { name: "gemini: 60% left" });
    await revealedSegment.click();
    await expect.element(revealedSegment).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(screen.getByRole("dialog").getByText("Left", { exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "1 item hidden" }).click();
    await expect.element(revealedSegment).not.toBeInTheDocument();
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "1 item hidden" }).click();
    await screen.getByRole("button", { name: "Show Antigravity", exact: true }).click();
    await screen.getByRole("heading", { name: /Antigravity/ }).hover();
    await screen.getByRole("button", { name: "Collapse Antigravity limits" }).click();
    const providerHandle = screen.getByRole("button", { name: "Reorder Codex", exact: true });
    await userEvent.keyboard("{Shift}");
    providerHandle.element().focus();
    await expect.element(providerReorder).toHaveStyle({ opacity: "1" });
    await userEvent.keyboard("[Space]");
    await expect.element(providerHandle).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("[ArrowDown]");
    await userEvent.keyboard("[Space]");
    await expect.element(providerHandle).toHaveFocus();
    await expect.element(providerHandle).not.toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("heading", { level: 2 }).first())
      .toHaveTextContent("Antigravity");
    const weeklyHandle = screen.getByRole("button", { name: "Reorder Codex Weekly", exact: true });
    weeklyHandle.element().focus();
    await userEvent.keyboard("[Space]");
    await userEvent.keyboard("[ArrowUp]");
    await userEvent.keyboard("[Space]");
    await expect.element(weeklyHandle).toHaveFocus();
    const saved = JSON.parse(window.localStorage.getItem(USAGE_LIMIT_LAYOUT_KEY)!);
    expect(saved.providerOrder).toEqual(["antigravity", "codex"]);
    expect(saved.windowOrder).toEqual([
      JSON.stringify(["codex", "weekly", "weekly"]),
      JSON.stringify(["codex", "session", "session"]),
    ]);
    await userEvent.keyboard("[Space]");
    await userEvent.keyboard("[ArrowDown]");
    await userEvent.keyboard("[Escape]");
    expect(JSON.parse(window.localStorage.getItem(USAGE_LIMIT_LAYOUT_KEY)!)).toEqual(saved);
    await screen.getByRole("heading", { name: /Codex/ }).hover();
    await screen.getByRole("button", { name: "Collapse Codex limits" }).click();
    await screen.getByRole("button", { name: "Hide Codex", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: /Codex/ })).not.toBeInTheDocument();

    await expect.element(screen.getByRole("button", { name: "1 item hidden" })).toHaveFocus();
    await screen.getByRole("button", { name: "1 item hidden" }).click();
    await screen.getByRole("button", { name: "Show Codex", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "1 item hidden" }))
      .not.toBeInTheDocument();
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
    await screen.getByRole("heading", { name: /Antigravity/ }).hover();
    await screen.getByRole("button", { name: "Collapse Antigravity limits" }).click();
    await dragHandle(
      screen.getByRole("button", { name: "Reorder Codex", exact: true }).element(),
      screen.getByRole("button", { name: "Reorder Antigravity", exact: true }).element(),
    );
    await expect
      .element(screen.getByRole("heading", { level: 2 }).first())
      .toHaveTextContent("Antigravity");
    await dragHandle(
      screen.getByRole("button", { name: "Reorder Codex Session", exact: true }).element(),
      screen.getByRole("button", { name: "Reorder Codex Weekly", exact: true }).element(),
    );
    await commands.resetPointer();
    await expect
      .element(
        screen.getByRole("button", { name: "Reorder Codex Session", exact: true }).element()
          .parentElement!,
      )
      .toHaveStyle({ opacity: "0" });
    expect(JSON.parse(window.localStorage.getItem(USAGE_LIMIT_LAYOUT_KEY)!)).toMatchObject({
      providerOrder: ["antigravity", "codex"],
      windowOrder: [
        JSON.stringify(["codex", "weekly", "weekly"]),
        JSON.stringify(["codex", "session", "session"]),
      ],
    });
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
