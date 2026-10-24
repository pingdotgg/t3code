import { act, render } from "../../../test/render";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProviderInstanceId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

type Presentations = ReadonlyMap<EnvironmentId, Record<string, unknown>>;
const state = vi.hoisted(() => ({
  presentations: null as unknown as Atom.Writable<Presentations>,
  refreshProviders: vi.fn<(input: unknown) => Promise<undefined>>(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
  useCanGoBack: () => false,
}));
// Real presentations come from live connections; these tests drive them directly.
vi.mock(import("../../state/presentation"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const presentations = Atom.make<Presentations>(new Map()).pipe(Atom.keepAlive);
  state.presentations = presentations;
  const providers = Atom.make(
    (get) =>
      new Map(
        [...get(presentations)].map(([id, presentation]) => [
          id,
          (presentation.serverConfig as { providers: unknown }).providers,
        ]),
      ),
  );
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: presentations as never,
      presentationsWithProvidersAtom: presentations as never,
      providersByEnvironmentAtom: providers as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.refreshProviders) as never,
}));
vi.mock(import("../../state/usage"), async (original) => {
  const environment = {
    environmentId: EnvironmentId.make("test"),
    label: "Test",
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary: null,
  };
  return {
    ...(await original()),
    useUsage: (() => ({
      merged: mergeUsage([], USAGE_CONTRACT_VERSION),
      environments: [environment],
      selectedEnvironments: [environment],
      isPending: false,
      shown: null,
      isPartial: false,
      refresh: async () => undefined,
    })) as never,
  };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { UsagePage } from "./UsagePage";

const PREFERENCES_KEY = "t3code:usage-page-preferences:v1";
function setup() {
  state.refreshProviders.mockReset().mockResolvedValue(undefined);
}
function presentation(phase = "connected") {
  return {
    entry: { target: { label: "Test" } },
    connection: { phase, error: null, traceId: null },
    serverConfig: {
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-09-11T12:00:00Z",
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: {
            checkedAt: "2026-09-11T12:00:00Z",
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 40,
                windowDurationMins: 300,
                resetsAt: "2026-09-11T14:00:00Z",
              },
            ],
          },
        },
      ],
    },
  };
}

const setPresentations = (entries: ReadonlyArray<readonly [EnvironmentId, object]>) =>
  act(async () => appAtomRegistry.set(state.presentations, new Map(entries) as Presentations));
const refreshButton = () => page.getByRole("button", { name: "Refresh limits" });

it("refreshes the account credit balance independently of an exhausted allowance", async () => {
  setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-11T12:00:00Z"));
  await page.viewport(1440, 900);
  const original = localStorage.getItem(PREFERENCES_KEY);
  using _preferences = {
    [Symbol.dispose]() {
      if (original === null) localStorage.removeItem(PREFERENCES_KEY);
      else localStorage.setItem(PREFERENCES_KEY, original);
    },
  };
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ metric: "limits", windowDays: 30 }));
  const environmentId = EnvironmentId.make("purchased-credits-refresh");
  const presentBalance = async (balance: string | null) => {
    const value = presentation();
    const provider = value.serverConfig.providers[0]!;
    await setPresentations([
      [
        environmentId,
        {
          ...value,
          serverConfig: {
            providers: [
              {
                ...provider,
                usageLimits: {
                  ...provider.usageLimits,
                  windows: [{ ...provider.usageLimits.windows[0]!, usedPercent: 100 }],
                  credits:
                    balance === null ? null : { hasCredits: true, unlimited: false, balance },
                },
              },
            ],
          },
        },
      ],
    ]);
  };
  await presentBalance("12345.67");
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <UsagePage />
    </RegistryContext.Provider>,
  );
  await expect.element(page.getByText("ChatGPT credits", { exact: true })).toBeVisible();
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(12345.67);
  await expect.element(page.getByText(`${formatted} remaining`, { exact: true })).toBeVisible();
  state.refreshProviders.mockImplementationOnce(async () => {
    await presentBalance("42");
    return undefined;
  });
  await userEvent.click(refreshButton());
  await expect.element(page.getByText("42 remaining", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(`${formatted} remaining`, { exact: true }))
    .not.toBeInTheDocument();
  await presentBalance(null);
  await expect.element(page.getByText("ChatGPT credits", { exact: true })).not.toBeInTheDocument();
});
