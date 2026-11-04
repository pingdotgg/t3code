import "~/index.css";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page, type Locator } from "vite-plus/test/browser";

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

const checkedAt = "2026-10-25T16:00:00.000Z";
const now = Date.parse(checkedAt);
const sessionWindow = {
  id: "session",
  kind: "session",
  label: "Session",
  usedPercent: 35,
  windowDurationMins: 300,
  resetsAt: "2026-10-25T18:00:00.000Z",
} as const;

function setup(): Disposable {
  persistence.getClientSettings.mockReset().mockResolvedValue(null);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  return { [Symbol.dispose]: __resetClientSettingsPersistenceForTests };
}

function usageProvider(blocked: boolean) {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: blocked
        ? [
            sessionWindow,
            {
              ...sessionWindow,
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 100,
            },
          ]
        : [sessionWindow],
    },
  } satisfies ServerProvider;
}

function UsageLimitsFixture({ blocked = false }: { readonly blocked?: boolean }) {
  const provider = usageProvider(blocked);
  const presentations = new Map([
    [
      EnvironmentId.make("desk"),
      { entry: { target: { label: "Desk" } }, serverConfig: { providers: [provider] } },
    ],
  ]);
  return (
    <main className="mx-auto max-w-4xl space-y-8 bg-background p-6 text-foreground">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Usage limit display</h1>
          <p className="text-sm text-muted-foreground">
            Component integration fixture · synthetic quota data
          </p>
        </div>
        <div className="w-52">
          <UsageLimitDisplaySelect />
        </div>
      </header>

      <section aria-labelledby="fixture-usage-heading" className="space-y-3">
        <h2 id="fixture-usage-heading" className="text-sm font-medium">
          Usage view
        </h2>
        <UsageLimitsPooled presentations={presentations} now={now} />
      </section>

      <section aria-labelledby="fixture-card-heading" className="space-y-3">
        <h2 id="fixture-card-heading" className="text-sm font-medium">
          Thread details card
        </h2>
        <div className="rounded-lg border border-border p-3">
          <ThreadDetailsUsage
            providerInstanceId={provider.instanceId}
            providers={[provider]}
            sources={[]}
          />
        </div>
      </section>

      <section aria-labelledby="fixture-composer-heading" className="space-y-3">
        <h2 id="fixture-composer-heading" className="text-sm font-medium">
          Composer banner
        </h2>
        <div className="rounded-lg border border-border p-4">
          <LimitWindows
            compact
            driver={provider.driver}
            windows={provider.usageLimits.windows}
            now={now}
          />
        </div>
      </section>
    </main>
  );
}

async function expectComposerBar(composer: Locator, percent: number, pace: number) {
  await vi.waitFor(() => {
    const bar = composer.getByRole("img", { name: /^Session:/ }).element();
    const fill = bar.querySelector<HTMLElement>('[data-slot="usage-limit-fill"]')!;
    const marker = bar.querySelector<HTMLElement>('[data-slot="usage-limit-pace"]')!;
    expect(fill.style.width).toBe(`${percent}%`);
    const track = bar.getBoundingClientRect();
    const tick = marker.getBoundingClientRect();
    expect((tick.left + tick.width / 2 - track.left) / track.width).toBeCloseTo(pace / 100, 2);
  });
}

it("updates limit displays together, retains the preference after hydration, and switches back", async () => {
  using _settings = setup();
  await using screen = await render(<UsageLimitsFixture />);
  const pooled = screen.getByRole("region", { name: "Usage view" });
  const card = screen.getByRole("region", { name: "Thread details card" });
  const composer = screen.getByRole("region", { name: "Composer banner" });
  const selector = screen.getByRole("combobox", { name: "Usage limit display" });

  await expect.element(pooled.getByRole("button", { name: /65% left/ })).toBeVisible();
  await expect.element(card.getByLabelText("Session: 65% left")).toBeVisible();
  await expectComposerBar(composer, 65, 40);

  await selector.click();
  await page.getByRole("option", { name: "Used (fills up)" }).click();
  await expect.element(pooled.getByRole("button", { name: /35% used/ })).toBeVisible();
  await expect.element(card.getByLabelText("Session: 35% used")).toBeVisible();
  await expect
    .element(composer.getByRole("img", { name: /35% used, 60% of the window elapsed/ }))
    .toBeVisible();
  await expectComposerBar(composer, 35, 60);

  await screen.rerender(<UsageLimitsFixture blocked />);
  await expect.element(pooled.getByRole("button", { name: /100% unavailable/ })).toBeVisible();
  await expect.element(card.getByLabelText("Session: 35% used")).toBeVisible();
  await screen.rerender(<UsageLimitsFixture />);

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
  await screen.rerender(<UsageLimitsFixture />);
  await expect.element(selector).toHaveTextContent("Used (fills up)");
  await expectComposerBar(composer, 35, 60);

  await selector.click();
  await page.getByRole("option", { name: "Remaining (empties)" }).click();
  await expect.element(pooled.getByRole("button", { name: /65% left/ })).toBeVisible();
  await expect.element(card.getByLabelText("Session: 65% left")).toBeVisible();
  await expect
    .element(composer.getByRole("img", { name: /65% left, 40% of the window left/ }))
    .toBeVisible();
  await expectComposerBar(composer, 65, 40);
});
