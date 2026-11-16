import { USAGE_CONTRACT_VERSION, EnvironmentId, UsageDay } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { UsageView } from "../../state/usage";

const fixture = vi.hoisted(() => ({ useUsage: vi.fn() }));
vi.mock(import("../../state/usage"), async (original) => ({
  ...(await original()),
  useUsage: fixture.useUsage,
}));
vi.mock(import("./usagePagePreferences"), () => ({
  readUsagePagePreferences: () => ({ metric: "cost" as const, windowDays: 30 as const }),
  saveUsagePagePreferences: () => {},
}));
vi.mock(import("../AppRouteModal"), () => ({
  AppRouteModal: ({ children }: { children: ReactNode }) => <>{children}</>,
  AppRouteModalClose: () => <></>,
}));

import { UsagePage } from "./UsagePage";

it("keeps the Day breakdown when an empty read becomes pending and settles", async () => {
  fixture.useUsage.mockReset();
  const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
  const answered = {
    environmentId: EnvironmentId.make("workstation"),
    label: "Workstation",
    canReadDiagnostics: true,
    isConnected: true,
    isPending: false,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-11-16T00:00:00Z",
      timeZone: "UTC",
      sinceDay: UsageDay.make("2026-11-16"),
      untilDay: UsageDay.make("2026-11-16"),
      buckets: [],
      sources: [],
      pricing: { status: "fresh" as const, source: "test", fetchedAt: null, knownModels: 0 },
      scanDurationMs: 0,
    },
  };
  const useView = (
    window: Parameters<typeof import("../../state/usage").useUsage>[0],
  ): UsageView => ({
    merged,
    environments: [answered],
    selectedEnvironments: [answered],
    isPending: false,
    isPartial: false,
    shown: { merged, window },
    refresh: async () => {},
  });
  fixture.useUsage.mockImplementation(useView);
  await using screen = await render(<UsagePage />);
  await userEvent.click(screen.getByRole("button", { name: "Day", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Day", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  fixture.useUsage.mockImplementation((window) => ({
    ...useView(window),
    selectedEnvironments: [
      answered,
      { ...answered, environmentId: EnvironmentId.make("waiting"), summary: null, isPending: true },
    ],
  }));
  await screen.rerender(<UsagePage />);
  await expect
    .element(screen.getByRole("button", { name: "Day", exact: true }))
    .not.toBeInTheDocument();

  fixture.useUsage.mockImplementation(useView);
  await screen.rerender(<UsagePage />);
  await expect
    .element(screen.getByRole("button", { name: "Day", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});
