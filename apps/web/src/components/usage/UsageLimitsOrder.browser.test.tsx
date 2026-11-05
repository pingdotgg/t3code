import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AppRouteModal } from "../AppRouteModal";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import "../../index.css";

it("reorders visible providers without moving hidden ones and cancels inside the Usage modal", async () => {
  const now = Date.parse("2026-10-28T01:00:00.000Z");
  const checkedAt = new Date(now).toISOString();
  const usageWindow = (id: string, kind: "session" | "weekly", label: string) => ({
    id,
    kind,
    label,
    usedPercent: 29,
    resetsAt: "2026-10-28T03:55:00.000Z",
  });
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
              // Unequal section heights: Claude has two windows, Codex one.
              accounts: [
                { driver: "codex", windows: [usageWindow("weekly", "weekly", "Weekly")] },
                {
                  driver: "claudeAgent",
                  windows: [
                    usageWindow("primary", "session", "Session"),
                    usageWindow("weekly", "weekly", "Weekly"),
                  ],
                },
              ].map(({ driver, windows }) => ({
                id: driver,
                driver: ProviderDriverKind.make(driver),
                usageLimits: { checkedAt, windows },
              })),
            },
          ],
        },
      },
    ],
  ]);
  const onOrderChange = vi.fn();
  function Demo() {
    const [order, setOrder] = useState<readonly ProviderDriverKind[]>(
      ["codex", "cursor", "claudeAgent", "grok"].map((driver) => ProviderDriverKind.make(driver)),
    );
    return (
      <AppAtomRegistryProvider>
        <AppRouteModal label="Usage">
          <div style={{ width: 1000 }}>
            <UsageLimitsPooled
              presentations={presentations}
              now={now}
              providerOrder={order}
              onProviderOrderChange={(next) => {
                onOrderChange(next);
                setOrder(next);
              }}
            />
          </div>
        </AppRouteModal>
      </AppAtomRegistryProvider>
    );
  }
  await using _screen = await render(<Demo />, { router: "/usage" });
  const dialog = page.getByRole("dialog", { name: "Usage" });
  const headings = () => [...document.querySelectorAll("h2")].map((node) => node.textContent);
  await expect.element(dialog).toBeVisible();
  expect(headings()).toEqual(["Codex", "Claude"]);
  await page.getByRole("button", { name: "Reorder Claude" }).click();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowUp}");
  await userEvent.keyboard(" ");
  await vi.waitFor(() => expect(headings()).toEqual(["Claude", "Codex"]));
  expect(onOrderChange).toHaveBeenCalledExactlyOnceWith(["claudeAgent", "cursor", "codex", "grok"]);

  // Escape cancels the drag only; Usage stays open and the same grip picks up again.
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(headings()).toEqual(["Claude", "Codex"]));
  await expect.element(dialog).toHaveAttribute("data-open");
  expect(onOrderChange).toHaveBeenCalledTimes(1);
  await expect.element(page.getByRole("button", { name: "Reorder Claude" })).toHaveFocus();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard(" ");
  await vi.waitFor(() => expect(headings()).toEqual(["Codex", "Claude"]));
  expect(onOrderChange).toHaveBeenLastCalledWith(["codex", "cursor", "claudeAgent", "grok"]);

  // The same holds for a pointer drag, and the grip can be grabbed again afterwards.
  const grip = page.getByRole("button", { name: "Reorder Claude" });
  const pointer = (type: string, clientY: number, buttons = 1) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerId: 1,
      button: 0,
      buttons,
      clientX: grip.element().getBoundingClientRect().left,
      clientY,
    });
  const dragClaudeUp = async () => {
    const top = grip.element().getBoundingClientRect().top;
    grip.element().dispatchEvent(pointer("pointerdown", top));
    // The first move only activates the drag; the second one moves it.
    document.dispatchEvent(pointer("pointermove", top - 10));
    await expect.element(grip).toHaveAttribute("aria-pressed", "true");
    document.dispatchEvent(pointer("pointermove", top - 200));
    await expect.element(page.getByText(/over droppable area codex\./)).toBeInTheDocument();
    return top - 200;
  };
  const cancelledAt = await dragClaudeUp();
  await userEvent.keyboard("{Escape}");
  await expect.element(grip).not.toHaveAttribute("aria-pressed");
  document.dispatchEvent(pointer("pointerup", cancelledAt, 0));
  await expect.element(dialog).toHaveAttribute("data-open");
  expect(headings()).toEqual(["Codex", "Claude"]);
  expect(onOrderChange).toHaveBeenCalledTimes(2);
  document.dispatchEvent(pointer("pointerup", await dragClaudeUp(), 0));
  await vi.waitFor(() => expect(headings()).toEqual(["Claude", "Codex"]));
  expect(onOrderChange).toHaveBeenCalledTimes(3);

  // With no drag in progress, Escape closes Usage as before.
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});
