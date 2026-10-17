import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type PreviewReportProfilesInput,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  electron: true,
  hydrated: false,
  settings: {} as typeof DEFAULT_CLIENT_SETTINGS,
  configs: new Map<EnvironmentId, { environment: { capabilities: { serverBrowser: boolean } } }>(),
  operable: new Set<EnvironmentId>(),
  report:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: PreviewReportProfilesInput;
      }) => Promise<void>
    >(),
}));

vi.mock("~/env", () => ({
  get isElectron() {
    return mocks.electron;
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector(mocks.settings),
  useClientSettingsHydrated: () => mocks.hydrated,
}));
vi.mock("~/state/entities", () => ({ useServerConfigs: () => mocks.configs }));
vi.mock("~/state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("~/state/session", () => ({ useEnvironmentsWithScope: () => mocks.operable }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { reportProfiles: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.report }));

import { BrowserProfileReporter } from "./BrowserProfileReporter";

let renderer: ReactTestRenderer | undefined;
const environmentId = EnvironmentId.make("recording-environment");

beforeEach(() => {
  mocks.electron = true;
  mocks.settings = { ...DEFAULT_CLIENT_SETTINGS, browserRecordingFrameRate: 60 };
  mocks.hydrated = false;
  mocks.configs = new Map([
    [environmentId, { environment: { capabilities: { serverBrowser: true } } }],
    [EnvironmentId.make("no-browser"), { environment: { capabilities: { serverBrowser: false } } }],
    [EnvironmentId.make("read-only"), { environment: { capabilities: { serverBrowser: true } } }],
  ]);
  mocks.operable = new Set([environmentId, EnvironmentId.make("no-browser")]);
  mocks.report.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reports the hydrated recording preference, edits, and reconnects only to operable browsers", async () => {
  await act(() => {
    renderer = create(<BrowserProfileReporter />);
  });
  expect(mocks.report).not.toHaveBeenCalled();

  mocks.hydrated = true;
  await act(() => renderer!.update(<BrowserProfileReporter />));
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { profiles: [], defaultProfileId: "default", recordingFrameRate: 60 },
  });

  mocks.settings = { ...mocks.settings, browserRecordingFrameRate: 30 };
  await act(() => renderer!.update(<BrowserProfileReporter />));
  expect(mocks.report).toHaveBeenCalledTimes(2);
  expect(mocks.report).toHaveBeenLastCalledWith({
    environmentId,
    input: { profiles: [], defaultProfileId: "default", recordingFrameRate: 30 },
  });

  mocks.configs = new Map(mocks.configs);
  await act(() => renderer!.update(<BrowserProfileReporter />));
  expect(mocks.report).toHaveBeenCalledTimes(3);
  expect(mocks.report).toHaveBeenLastCalledWith({
    environmentId,
    input: { profiles: [], defaultProfileId: "default", recordingFrameRate: 30 },
  });
});

it("keeps a web client's default rate out of desktop recording preferences on connect and reconnect", async () => {
  mocks.hydrated = true;
  await act(() => {
    renderer = create(<BrowserProfileReporter />);
  });
  expect(mocks.report).toHaveBeenLastCalledWith({
    environmentId,
    input: { profiles: [], defaultProfileId: "default", recordingFrameRate: 60 },
  });
  await act(() => renderer!.unmount());

  mocks.electron = false;
  mocks.settings = { ...DEFAULT_CLIENT_SETTINGS };
  mocks.report.mockClear();
  await act(() => {
    renderer = create(<BrowserProfileReporter />);
  });
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { profiles: [], defaultProfileId: "default" },
  });

  mocks.configs = new Map(mocks.configs);
  await act(() => renderer!.update(<BrowserProfileReporter />));
  expect(mocks.report).toHaveBeenCalledTimes(2);
  expect(mocks.report).toHaveBeenLastCalledWith({
    environmentId,
    input: { profiles: [], defaultProfileId: "default" },
  });
});
