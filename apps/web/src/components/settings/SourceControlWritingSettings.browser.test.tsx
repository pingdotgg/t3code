import { render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

type WritingStyle = typeof DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
const state = vi.hoisted(() => ({
  styles: [] as WritingStyle[],
  providerInstances: {} as typeof DEFAULT_UNIFIED_SETTINGS.providerInstances,
  providers: new Map<EnvironmentId, readonly ServerProvider[]>(),
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    sourceControlWritingStyle: state.styles[0],
    providerInstances: state.providerInstances,
  })) as never,
  useScopedSettingsMixed: (keys) =>
    !keys.includes("reviewGuidesEnabled") &&
    JSON.stringify(state.styles[0]) !== JSON.stringify(state.styles[1]),
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    environment: { environmentId: EnvironmentId.make("representative"), serverConfig: {} },
    connectedEnvironments: [...state.providers.keys()].map((environmentId) => ({
      environmentId,
      serverConfig: {},
    })),
    representative: { environmentId: EnvironmentId.make("representative") },
    targets: state.styles.map((style, index) => ({
      environmentId: EnvironmentId.make(`environment-${index}`),
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: state.providerInstances,
        sourceControlWritingStyle: style,
      },
    })),
    target: null,
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => state.providers,
  useEnvironments: (() => ({
    environments: [...state.providers.keys()].map((environmentId) => ({
      environmentId,
      label: environmentId,
      serverConfig: {},
    })),
  })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, control, resetAction, children }) => (
    <div>
      <h3>{title}</h3>
      {control}
      {resetAction}
      {children}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";

const resetButton = (label: string) =>
  page.getByRole("button", { name: `Reset ${label} to default` });

const content = () => (
  <StrictMode>
    <SourceControlWritingSettingsSection />
  </StrictMode>
);

async function setup() {
  state.providers = new Map();
  state.providerInstances = {};
  state.styles = [
    {
      ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
      mode: "custom",
      customInstructions: "First environment instructions",
      followChangeRequestTemplates: true,
    },
    {
      ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
      mode: "custom",
      customInstructions: "Second environment instructions",
      followChangeRequestTemplates: false,
    },
  ];
  const screen = await render(content());
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.styles = state.styles.map((style) => ({ ...style, ...patch.sourceControlWritingStyle }));
    void screen.rerender(content());
  });
  return screen;
}

describe("mixed source control instructions", () => {
  it("resets mixed template preferences without replacing each environment's instructions", async () => {
    await using _screen = await setup();
    const initialInstructions = state.styles.map(({ mode, customInstructions }) => ({
      mode,
      customInstructions,
    }));

    await userEvent.click(page.getByRole("button", { name: "Advanced" }));
    await userEvent.click(resetButton("change request templates"));

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.followChangeRequestTemplates)).toEqual([
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
    ]);
    expect(
      state.styles.map(({ mode, customInstructions }) => ({ mode, customInstructions })),
    ).toEqual(initialInstructions);
  });
});

it("rejects a scoped model when another environment requires extensions for it", async () => {
  state.updateSettings.mockReset();
  state.styles = [DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle];
  const instanceId = ProviderInstanceId.make("pi");
  state.providerInstances = {
    [instanceId]: { driver: ProviderDriverKind.make("pi"), enabled: true },
  };
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("pi"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [{ slug: "demo/model", name: "Demo", isCustom: false, capabilities: {} }],
  };
  state.providers = new Map([
    [EnvironmentId.make("representative"), [provider]],
    [
      EnvironmentId.make("environment-0"),
      [
        {
          ...provider,
          models: provider.models.map((model) => ({ ...model, supportsTextGeneration: false })),
        },
      ],
    ],
  ]);
  function Availability() {
    const backgroundReason = useScopedModelDisabledReason(
      { ...DEFAULT_UNIFIED_SETTINGS, providerInstances: state.providerInstances },
      deriveProviderInstanceEntries([provider]),
      true,
    );
    const threadReason = useScopedModelDisabledReason(
      { ...DEFAULT_UNIFIED_SETTINGS, providerInstances: state.providerInstances },
      deriveProviderInstanceEntries([provider]),
    );
    return (
      <>
        <p>{backgroundReason(instanceId, "demo/model") ?? "Available"}</p>
        <p>{threadReason(instanceId, "demo/model") ?? "Available for threads"}</p>
      </>
    );
  }
  const availability = () => (
    <>
      <Availability />
      <SourceControlWritingSettingsSection />
    </>
  );
  await using screen = await render(availability());
  await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
  await userEvent.click(
    screen.getByRole("switch", { name: "Use a separate source control writer model" }),
  );
  expect(state.updateSettings).not.toHaveBeenCalled();
  await expect.element(screen.getByText("Available for threads")).toBeVisible();
  await expect
    .element(
      screen.getByText(
        "This model is unavailable on environment-0. Select that environment to choose its model separately.",
      ),
    )
    .toBeVisible();
  state.providers = new Map([
    [EnvironmentId.make("representative"), [provider]],
    [EnvironmentId.make("environment-0"), [provider]],
  ]);
  await screen.rerender(availability());
  await userEvent.click(
    screen.getByRole("switch", { name: "Use a separate source control writer model" }),
  );
  expect(state.updateSettings).toHaveBeenCalledWith({
    sourceControlWriterModelSelection: { instanceId, model: "demo/model" },
  });
});
