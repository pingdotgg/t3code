import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsageStatusBar } from "./UsageStatusBar";

vi.mock(import("../../hooks/useSettings"), () => ({
  usePrimarySettings: (() => "24-hour") as never,
}));

const checkedAt = "2026-10-27T10:00:00.000Z";
const session = {
  id: "primary",
  kind: "session",
  label: "Session",
  windowDurationMins: 300,
  usedPercent: 28,
  resetsAt: "2026-10-27T14:00:00.000Z",
} as const;
const weekly = { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 59 } as const;

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows: [session, weekly] },
    ...overrides,
  };
}

const defaults = { connected: true, loading: false } as const;

describe("UsageStatusBar", () => {
  it("follows the active agent and applies live subscription updates", async () => {
    const claude = provider({
      instanceId: ProviderInstanceId.make("claude"),
      driver: ProviderDriverKind.make("claudeAgent"),
      usageLimits: {
        checkedAt,
        windows: [
          { ...session, usedPercent: 100 },
          { ...weekly, usedPercent: 0 },
        ],
      },
    });
    await using screen = await render(<UsageStatusBar {...defaults} provider={provider()} />);
    await expect
      .element(screen.getByRole("meter", { name: "Codex 5h remaining" }).getByText("72% left"))
      .toBeVisible();
    await expect
      .element(screen.getByRole("meter", { name: "Codex Weekly remaining" }).getByText("41% left"))
      .toBeVisible();
    await screen.rerender(
      <UsageStatusBar
        {...defaults}
        provider={provider({
          usageLimits: { checkedAt, windows: [{ ...session, usedPercent: 60 }, weekly] },
        })}
      />,
    );
    await expect
      .element(screen.getByRole("meter", { name: "Codex 5h remaining" }).getByText("40% left"))
      .toBeVisible();
    await expect
      .element(screen.getByRole("meter", { name: "Codex Weekly remaining" }).getByText("41% left"))
      .toBeVisible();
    await screen.rerender(<UsageStatusBar {...defaults} provider={claude} />);
    await expect
      .element(screen.getByRole("meter", { name: "Claude 5h remaining" }).getByText("0% left"))
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("meter", { name: "Claude Weekly remaining" }).getByText("100% left"),
      )
      .toBeVisible();

    await expect
      .element(screen.getByRole("meter", { name: "Codex 5h remaining" }))
      .not.toBeInTheDocument();
  });

  it("labels cached data offline and replaces it when the conversation environment changes", async () => {
    await using screen = await render(
      <UsageStatusBar {...defaults} provider={provider()} connected={false} />,
    );
    await expect.element(screen.getByText("Offline · last known usage")).toBeVisible();
    await expect
      .element(screen.getByRole("meter", { name: "Codex 5h remaining" }))
      .toHaveAttribute("aria-valuetext", "72% left (last known)");

    await screen.rerender(<UsageStatusBar {...defaults} provider={null} loading />);
    await expect.element(screen.getByText("Loading usage…")).toBeVisible();
    await expect.element(screen.getByRole("meter")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Offline · last known usage")).not.toBeInTheDocument();
  });

  it("does not present failed probes as current quota or invent missing windows", async () => {
    const failed = provider({
      usageLimits: {
        checkedAt,
        windows: [session, weekly],
        unavailable: { reason: "probeFailed" },
      },
    });
    await using screen = await render(<UsageStatusBar {...defaults} provider={failed} />);
    await expect.element(screen.getByText("Subscription usage unavailable")).toBeVisible();
    await expect.element(screen.getByRole("meter")).not.toBeInTheDocument();

    await screen.rerender(
      <UsageStatusBar
        {...defaults}
        provider={provider({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          usageLimits: {
            checkedAt,
            windows: [],
            unavailable: {
              reason: "unsupported",
              message: "Sign in to Cursor CLI with the same account selected in T3 Code.",
            },
          },
        })}
      />,
    );
    await expect
      .element(screen.getByText("Sign in to Cursor CLI with the same account selected in T3 Code."))
      .toBeVisible();
    await expect.element(screen.getByRole("meter")).not.toBeInTheDocument();

    await screen.rerender(
      <UsageStatusBar
        {...defaults}
        provider={provider({
          usageLimits: {
            checkedAt,
            windows: [{ ...session, kind: "monthly", label: "Monthly", windowDurationMins: 43200 }],
          },
        })}
      />,
    );
    await expect
      .element(screen.getByRole("meter", { name: "Codex Monthly remaining" }).getByText("72% left"))
      .toBeVisible();
    await expect
      .element(screen.getByRole("meter", { name: "Codex 5h remaining" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("meter", { name: "Codex Weekly remaining" }))
      .not.toBeInTheDocument();
  });

  it("follows account switches and exposes reset details on keyboard focus", async () => {
    const personal = provider({ displayName: "Personal" });
    const work = provider({
      instanceId: ProviderInstanceId.make("codex-work"),
      displayName: "Work",
      auth: { status: "authenticated", email: "work@example.com" },
      usageLimits: { checkedAt, windows: [{ ...session, usedPercent: 80 }] },
    });
    await using screen = await render(<UsageStatusBar {...defaults} provider={personal} />);
    await screen.rerender(<UsageStatusBar {...defaults} provider={work} />);
    expect(screen.getByRole("meter").elements()).toHaveLength(1);
    await expect
      .element(
        screen.getByRole("meter", { name: "Codex · Work 5h remaining" }).getByText("20% left"),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("img", { name: "Codex · Personal" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText("work@example.com")).not.toBeInTheDocument();
    await userEvent.tab();
    await expect.element(page.getByText("Codex · Work", { exact: true })).toBeVisible();
    await userEvent.tab();
    await expect.element(page.getByText(/^Resets /)).toBeVisible();
    await expect.element(page.getByText(/^Updated /)).toBeVisible();
    await userEvent.tab();
    await expect.element(screen.getByRole("link", { name: "View usage details" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(screen.router!.state.location.pathname).toBe("/usage"));
  });
});
