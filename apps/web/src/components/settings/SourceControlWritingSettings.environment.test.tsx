import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("remote-device");

const routing = vi.hoisted(() => ({
  providerReads: [] as EnvironmentId[],
  settingsReads: [] as EnvironmentId[],
  settingsUpdates: [] as EnvironmentId[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useRef: () => ({ current: null }),
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: () => [],
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (targetEnvironmentId: EnvironmentId) => {
    routing.settingsReads.push(targetEnvironmentId);
    return DEFAULT_UNIFIED_SETTINGS;
  },
  useUpdateEnvironmentSettings: (targetEnvironmentId: EnvironmentId) => {
    routing.settingsUpdates.push(targetEnvironmentId);
    return vi.fn();
  },
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: (targetEnvironmentId: EnvironmentId) => {
      routing.providerReads.push(targetEnvironmentId);
      return Symbol("providers");
    },
  },
}));

import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";

describe("Source Control writing settings environment routing", () => {
  beforeEach(() => {
    routing.providerReads = [];
    routing.settingsReads = [];
    routing.settingsUpdates = [];
  });

  it("reads and updates settings and provider models for the selected environment", () => {
    SourceControlWritingSettingsSection({ environmentId });

    expect(routing.settingsReads).toEqual([environmentId]);
    expect(routing.settingsUpdates).toEqual([environmentId]);
    expect(routing.providerReads).toEqual([environmentId]);
  });
});
