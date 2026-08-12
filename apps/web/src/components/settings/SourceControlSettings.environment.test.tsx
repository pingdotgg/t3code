import type { ReactElement } from "react";
import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const environmentId = EnvironmentId.make("remote-device");
const primaryEnvironmentId = EnvironmentId.make("primary-device");

const routing = vi.hoisted(() => ({
  discoveryTargets: [] as Array<{ readonly environmentId: EnvironmentId; readonly input: {} }>,
  settingsReads: [] as EnvironmentId[],
  settingsUpdates: [] as EnvironmentId[],
}));

const environmentState = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>,
  primaryEnvironmentId: null as EnvironmentId | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

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

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { versionControlSystems: [], sourceControlProviders: [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: environmentState.environments,
    isReady: true,
  }),
  usePrimaryEnvironmentId: () => environmentState.primaryEnvironmentId,
}));

vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    discovery: (target: { readonly environmentId: EnvironmentId; readonly input: {} }) => {
      routing.discoveryTargets.push(target);
      return Symbol("source-control-discovery");
    },
  },
}));

vi.mock("./SourceControlWritingSettings", () => ({
  SourceControlWritingSettingsSection: (props: {
    readonly environmentId: EnvironmentId;
    readonly readOnly?: boolean;
  }) => <div data-writing-environment={props.environmentId} data-read-only={props.readOnly} />,
}));

import {
  EnvironmentSourceControlSettings,
  GitFetchIntervalSettings,
  SourceControlSettingsPanel,
} from "./SourceControlSettings";

describe("Source Control environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    environmentState.environments = [
      { environmentId: primaryEnvironmentId, label: "This device" },
      { environmentId, label: "Remote device" },
    ];
    environmentState.primaryEnvironmentId = primaryEnvironmentId;
    routing.discoveryTargets = [];
    routing.settingsReads = [];
    routing.settingsUpdates = [];
  });

  it("retargets the panel when another environment is selected", () => {
    hooks.beginRender();
    let panel = SourceControlSettingsPanel() as ReactElement<Record<string, unknown>>;
    const selector = visitElements(
      panel,
      (element) => element.props.selectedEnvironmentId === primaryEnvironmentId,
    );
    expect(selector).not.toBeNull();

    (selector?.props.onSelect as ((environmentId: EnvironmentId) => void) | undefined)?.(
      environmentId,
    );

    hooks.beginRender();
    panel = SourceControlSettingsPanel() as ReactElement<Record<string, unknown>>;
    expect(
      visitElements(
        panel,
        (element) =>
          (element.props.environment as { readonly environmentId?: EnvironmentId } | undefined)
            ?.environmentId === environmentId,
      ),
    ).not.toBeNull();
  });

  it("routes discovery and writing settings to the selected environment", () => {
    const panel = EnvironmentSourceControlSettings({
      environmentId,
      environmentLabel: "Remote device",
    }) as ReactElement<Record<string, unknown>>;

    expect(routing.discoveryTargets).toEqual([{ environmentId, input: {} }]);
    expect(
      visitElements(panel, (element) => element.props.environmentId === environmentId),
    ).not.toBeNull();
  });

  it("renders environment-owned write controls read only when access is limited", () => {
    const panel = EnvironmentSourceControlSettings({
      environmentId,
      environmentLabel: "Remote device",
      readOnly: true,
    }) as ReactElement<Record<string, unknown>>;

    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).not.toBeNull();
    expect(
      visitElements(
        panel,
        (element) =>
          element.props.environmentId === environmentId && element.props.readOnly === true,
      ),
    ).not.toBeNull();
  });

  it("routes Git fetch policy reads and writes to the selected environment", () => {
    GitFetchIntervalSettings({ environmentId });

    expect(routing.settingsReads).toEqual([environmentId]);
    expect(routing.settingsUpdates).toEqual([environmentId]);
  });
});
