import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import "../../index.css";

it("reorders providers with the keyboard and cancels an uncommitted move", async () => {
  const now = Date.parse("2026-10-28T01:00:00.000Z");
  const checkedAt = new Date(now).toISOString();
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
              accounts: ["codex", "claudeAgent"].map((driver) => ({
                id: driver,
                driver: ProviderDriverKind.make(driver),
                usageLimits: {
                  checkedAt,
                  windows: [
                    {
                      id: "primary",
                      kind: "session",
                      label: "Session",
                      usedPercent: 29,
                      resetsAt: "2026-10-28T03:55:00.000Z",
                    },
                  ],
                },
              })),
            },
          ],
        },
      },
    ],
  ]);
  function Demo() {
    const [order, setOrder] = useState<readonly ProviderDriverKind[]>([]);
    return (
      <AppAtomRegistryProvider>
        <UsageLimitsPooled
          presentations={presentations}
          now={now}
          providerOrder={order}
          onProviderOrderChange={setOrder}
        />
      </AppAtomRegistryProvider>
    );
  }
  const container = document.createElement("div");
  container.style.width = "1000px";
  await using screen = await render(<Demo />, { container });
  const headings = () =>
    [...screen.container.querySelectorAll("h2")].map((node) => node.textContent);
  expect(headings()).toEqual(["Codex", "Claude"]);
  await screen.getByRole("button", { name: "Reorder Claude" }).click();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowUp}");
  await userEvent.keyboard(" ");
  await vi.waitFor(() => expect(headings()).toEqual(["Claude", "Codex"]));
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(headings()).toEqual(["Claude", "Codex"]));
});
