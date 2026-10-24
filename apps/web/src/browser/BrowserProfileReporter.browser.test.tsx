import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type ClientSettings,
  type PreviewReportProfilesInput,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  configs: new Map<EnvironmentId, { environment: { capabilities: { serverBrowser: boolean } } }>(),
  operable: new Set<EnvironmentId>(),
  report:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: PreviewReportProfilesInput;
      }) => Promise<void>
    >(),
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: false }));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() => mocks.configs) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentsWithScope: () => mocks.operable,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.report) as never,
}));
vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { BrowserProfileReporter } from "./BrowserProfileReporter";

it("omits the web client's default recording rate on connect and reconnect", async () => {
  __resetClientSettingsPersistenceForTests();
  using _state = { [Symbol.dispose]: __resetClientSettingsPersistenceForTests };
  const environmentId = EnvironmentId.make("web-profile-report");
  mocks.configs = new Map([
    [environmentId, { environment: { capabilities: { serverBrowser: true } } }],
  ]);
  mocks.operable = new Set([environmentId]);
  mocks.report.mockReset().mockResolvedValue(undefined);
  mocks.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  await ensureClientSettingsHydrated();
  const reporter = () => (
    <AppAtomRegistryProvider>
      <BrowserProfileReporter />
    </AppAtomRegistryProvider>
  );
  await using screen = await render(reporter());
  const report = { environmentId, input: { profiles: [], defaultProfileId: "default" } };
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith(report);

  mocks.configs = new Map(mocks.configs);
  await screen.rerender(reporter());
  expect(mocks.report).toHaveBeenCalledTimes(2);
  expect(mocks.report).toHaveBeenLastCalledWith(report);
});
