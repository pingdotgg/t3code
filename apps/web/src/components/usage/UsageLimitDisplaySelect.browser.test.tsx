import "~/index.css";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  ensureClientSettingsHydrated,
  getClientSettings,
} from "../../hooks/useSettings";
import { ThreadDetailsUsage } from "../chat/ThreadDetailsUsage";
import { UsageLimitDisplaySelect } from "./UsageLimitDisplaySelect";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { LimitWindows } from "./UsageLimits";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));
vi.mock("../../localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));

const now = Date.parse("2026-10-25T16:00:00.000Z");
const window = {
  id: "session",
  kind: "session",
  label: "Session",
  usedPercent: 35,
  windowDurationMins: 300,
  resetsAt: "2026-10-25T18:00:00.000Z",
} as const;

it("updates pooled, details-card and composer limits together, persists, and switches back", async () => {
  persistence.getClientSettings.mockReset().mockResolvedValue(null);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  using _settings = { [Symbol.dispose]: __resetClientSettingsPersistenceForTests };
  const provider = {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: new Date(now).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: new Date(now).toISOString(), windows: [window] },
  };
  const presentations = new Map([
    [
      EnvironmentId.make("desk"),
      { entry: { target: { label: "Desk" } }, serverConfig: { providers: [provider] } },
    ],
  ]);
  const ui = (blocked = false) => {
    const shownProvider = blocked
      ? {
          ...provider,
          usageLimits: {
            ...provider.usageLimits,
            windows: [
              window,
              {
                ...window,
                id: "seven_day",
                kind: "weekly" as const,
                label: "Weekly",
                usedPercent: 100,
              },
            ],
          },
        }
      : provider;
    const shownPresentations = blocked
      ? new Map([
          [
            EnvironmentId.make("desk"),
            { entry: { target: { label: "Desk" } }, serverConfig: { providers: [shownProvider] } },
          ],
        ])
      : presentations;
    return (
      <>
        <UsageLimitDisplaySelect />
        <div data-testid="pooled">
          <UsageLimitsPooled presentations={shownPresentations} now={now} />
        </div>
        <div data-testid="card">
          <ThreadDetailsUsage
            providerInstanceId={provider.instanceId}
            providers={[shownProvider]}
            sources={[]}
          />
        </div>
        <div data-testid="composer">
          <LimitWindows
            driver={provider.driver}
            windows={shownProvider.usageLimits.windows}
            now={now}
          />
        </div>
      </>
    );
  };
  const container = document.createElement("div");
  container.style.width = "375px";
  await using screen = await render(ui(), { container });
  await vi.waitFor(() => {
    const selector = screen.getByRole("combobox", { name: "Usage limit display" }).element();
    expect(selector.getBoundingClientRect().right).toBeLessThanOrEqual(
      container.getBoundingClientRect().right,
    );
  });
  await expect
    .element(screen.getByTestId("pooled").getByRole("button", { name: /65% left/ }))
    .toBeVisible();
  await expect
    .element(screen.getByTestId("card").getByLabelText("Session: 65% left"))
    .toBeVisible();
  await screen.getByRole("combobox", { name: "Usage limit display" }).click();
  await page.getByRole("option", { name: "Used (fills up)" }).click();
  await expect
    .element(screen.getByTestId("pooled").getByRole("button", { name: /35% used/ }))
    .toBeVisible();
  await expect
    .element(screen.getByTestId("card").getByLabelText("Session: 35% used"))
    .toBeVisible();
  await expect
    .element(
      screen
        .getByTestId("composer")
        .getByRole("img", { name: /35% used, 60% of the window elapsed/ }),
    )
    .toBeVisible();
  await vi.waitFor(() => {
    const bar = screen.container.querySelector<HTMLElement>(
      '[data-testid="composer"] [role="img"]',
    )!;
    expect(bar.querySelector<HTMLElement>('div[style*="width:"]')?.style.width).toBe("35%");
    expect(bar.querySelector<HTMLElement>('span[style*="left:"]')?.style.left).toContain("60%");
  });
  await screen.rerender(ui(true));
  await expect
    .element(screen.getByTestId("pooled").getByRole("button", { name: /100% unavailable/ }))
    .toBeVisible();
  await expect
    .element(screen.getByTestId("card").getByLabelText("Session: 35% used"))
    .toBeVisible();
  await screen.rerender(ui());
  await vi.waitFor(() =>
    expect(persistence.setClientSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ usageLimitDisplay: "used" }),
    ),
  );
  const saved = getClientSettings();
  await screen.rerender(null);
  __resetClientSettingsPersistenceForTests();
  persistence.getClientSettings.mockResolvedValue(saved);
  await ensureClientSettingsHydrated();
  await screen.rerender(ui());
  await expect
    .element(screen.getByRole("combobox", { name: "Usage limit display" }))
    .toHaveTextContent("Used (fills up)");
  await screen.getByRole("combobox", { name: "Usage limit display" }).click();
  await page.getByRole("option", { name: "Remaining (empties)" }).click();
  await vi.waitFor(() => {
    const bar = screen.container.querySelector<HTMLElement>(
      '[data-testid="composer"] [role="img"]',
    )!;
    expect(bar.querySelector<HTMLElement>('div[style*="width:"]')?.style.width).toBe("65%");
    expect(bar.querySelector<HTMLElement>('span[style*="left:"]')?.style.left).toContain("40%");
  });
  await expect
    .element(screen.getByTestId("card").getByLabelText("Session: 65% left"))
    .toBeVisible();
  await expect
    .element(
      screen.getByTestId("composer").getByRole("img", { name: /65% left, 40% of the window left/ }),
    )
    .toBeVisible();
});
