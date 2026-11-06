import { render } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { applyServerSettingsPatch, resolveModelPreferences } from "@t3tools/shared/serverSettings";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

type WritingStyle = typeof DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
const state = vi.hoisted(() => ({
  styles: [] as WritingStyle[],
  settings: {} as UnifiedSettings,
  providers: [] as ServerProvider[],
  otherProviders: null as ServerProvider[] | null,
  connected: false,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

function environment() {
  return state.connected
    ? {
        environmentId: EnvironmentId.make("writing-settings"),
        label: "Writing environment",
        connection: { phase: "connected" as const },
        serverConfig: { settings: state.settings },
      }
    : null;
}

function environments() {
  const selected = environment();
  if (!selected) return [];
  return [
    selected,
    ...(state.otherProviders === null
      ? []
      : [{ ...selected, environmentId: EnvironmentId.make("other-writing-settings") }]),
  ];
}

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...state.settings,
    sourceControlWritingStyle: state.styles[0],
  })) as never,
  useScopedSettingsMixed: (keys) =>
    state.styles.length > 1 &&
    !keys.includes("reviewGuidesEnabled") &&
    JSON.stringify(state.styles[0]) !== JSON.stringify(state.styles[1]),
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const selected = environment();
    const connected = environments();
    const targets = (selected ? connected : [null]).flatMap((targetEnvironment) =>
      state.styles.map((style) => ({
        environmentId: targetEnvironment?.environmentId,
        projectId: null,
        settings: { ...state.settings, sourceControlWritingStyle: style },
      })),
    );
    return {
      scope: { kind: "all", environmentIds: connected.map((entry) => entry.environmentId) },
      environment: selected,
      connectedEnvironments: connected,
      targets,
      target: selected ? targets[0] : null,
    };
  }) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () =>
    new Map([
      [EnvironmentId.make("writing-settings"), state.providers],
      ...(state.otherProviders === null
        ? []
        : [[EnvironmentId.make("other-writing-settings"), state.otherProviders] as const]),
    ]),
  useEnvironments: (() => ({ environments: environments() })) as never,
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

async function setup(options?: {
  providers: ServerProvider[];
  otherProviders?: ServerProvider[];
  settings: Partial<UnifiedSettings>;
}) {
  state.providers = options?.providers ?? [];
  state.otherProviders = options?.otherProviders ?? null;
  state.connected = options !== undefined;
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    ...options?.settings,
    providerInstances: Object.fromEntries(
      state.providers.map((provider) => [
        provider.instanceId,
        { driver: provider.driver, enabled: provider.enabled },
      ]),
    ),
  };
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
  if (options) state.styles = [state.settings.sourceControlWritingStyle];
  const screen = await render(content());
  state.updateSettings.mockReset().mockImplementation((patch) => {
    const nextSettings = applyServerSettingsPatch(state.settings, patch);
    state.settings = {
      ...state.settings,
      ...nextSettings,
      ...resolveModelPreferences(nextSettings, state.settings),
    };
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
    // Mid-open, Playwright scrolls the clipped panel to reach the button, then the growing panel
    // shifts it between press and release and the click misses. Wait until the panel shows it.
    await expect.element(resetButton("change request templates")).toBeInViewport({ ratio: 1 });
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

it.each([false, true])(
  "uses a capable provider when enabling a separate review guide model, multiple environments=%s",
  async (multipleEnvironments) => {
    const writerId = ProviderInstanceId.make("muse");
    const reviewId = ProviderInstanceId.make("codex");
    const writer: ServerProvider = {
      instanceId: writerId,
      driver: ProviderDriverKind.make("muse"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      textGenerationOperations: [
        "generateCommitMessage",
        "generatePrContent",
        "generateBranchName",
        "generateThreadTitle",
        "generateKnowledgeCandidates",
        "generateConversationSummary",
      ],
      models: [{ slug: "writer-model", name: "Writer model", isCustom: false, capabilities: {} }],
      slashCommands: [],
      skills: [],
    };
    const reviewer: ServerProvider = {
      ...writer,
      instanceId: reviewId,
      driver: ProviderDriverKind.make("codex"),
      textGenerationOperations: ["generateReviewGuide"],
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: {} }],
    };
    await using screen = await setup({
      providers: [
        writer,
        ...(multipleEnvironments
          ? [{ ...reviewer, instanceId: ProviderInstanceId.make("reviewer-only-here") }]
          : []),
        reviewer,
      ],
      ...(multipleEnvironments ? { otherProviders: [writer, reviewer] } : {}),
      settings: {
        textGenerationModelSelection: { instanceId: writerId, model: "writer-model" },
        reviewGuidesEnabled: true,
      },
    });
    const toggle = page.getByRole("switch", { name: "Use a separate review guide model" });
    await expect.element(toggle).toBeEnabled();
    await userEvent.click(toggle);
    await expect.element(toggle).toBeChecked();
    expect(state.settings.reviewGuideModelSelection).toMatchObject({
      instanceId: reviewId,
      model: "gpt-5.4",
    });
    expect(state.settings.textGenerationModelSelection).toEqual({
      instanceId: writerId,
      model: "writer-model",
    });

    await userEvent.click(toggle);
    await expect.element(toggle).not.toBeChecked();
    state.providers = [writer];
    await screen.rerender(content());
    await expect.element(toggle).toBeDisabled();
    expect(state.settings.reviewGuideModelSelection).toBeNull();
  },
);
