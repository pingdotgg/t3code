import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import {
  planScopedSettingsPatch,
  resolveScopedSettingsTargets,
  resolveUnsupportedSettingKeys,
  scopedDisplaySettings,
  scopedSettingsAreMixed,
  type ScopedSettingsPatch,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

type WritingStyle = typeof DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
const state = vi.hoisted(() => ({
  styles: [] as WritingStyle[],
  unsupported: new Set<number>(),
  environments: [] as Array<Parameters<typeof resolveScopedSettingsTargets>[1][number]>,
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
    ...scopedDisplaySettings(targets()[0]!, targets()),
  })) as never,
  useScopedSettingsMixed: (keys) => scopedSettingsAreMixed(targets(), keys),
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: scope(),
    environment: state.environments[0] ?? null,
    environments: state.environments,
    connectedEnvironments: state.environments,
    targets: targets(),
    target: targets()[0] ?? null,
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => state.providers,
  useEnvironments: (() => ({ environments: state.environments })) as never,
}));
// The real row reads write permission and overrides from live environment state; this
// suite exercises the section's controls and scoped writes without a live connection.
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

function targets() {
  if (state.environments.length > 0)
    return resolveScopedSettingsTargets(scope(), state.environments);
  return state.styles.map((style, index) => ({
    settings: { ...DEFAULT_UNIFIED_SETTINGS, sourceControlWritingStyle: style },
    unsupportedSettingKeys: new Set(
      state.unsupported.has(index) ? ["sourceControlWritingStyle"] : [],
    ),
  }));
}

function scope() {
  return resolveSettingsScope({}, [], state.environments);
}

let root: Root;
let container: HTMLDivElement;

const resetButton = (label: string) =>
  page.getByRole("button", { name: `Reset ${label} to default` });
const writeForAll = () => page.getByRole("button", { name: "Write custom instructions for all" });
const applyToAll = () => page.getByRole("button", { name: "Apply instructions to all" });
const bulkEditor = () =>
  page.getByRole("textbox", {
    name: "Custom source control instructions for all selected environments",
  });

async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <SourceControlWritingSettingsSection />
      </StrictMode>,
    ),
  );
}

beforeEach(async () => {
  state.environments = [];
  state.providers = new Map();
  state.unsupported = new Set();
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
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.styles = state.styles.map((style) => ({ ...style, ...patch.sourceControlWritingStyle }));
    void render();
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("mixed source control instructions", () => {
  it("chooses and saves writer models using only environments that can store the setting", async () => {
    const primaryId = EnvironmentId.make("primary");
    const siblingId = EnvironmentId.make("sibling");
    const codexId = ProviderInstanceId.make("codex");
    const claudeId = ProviderInstanceId.make("claudeAgent");
    const codex: ServerProvider = {
      instanceId: codexId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [
        { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
        { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex", isCustom: false, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
    };
    const claude: ServerProvider = {
      ...codex,
      instanceId: claudeId,
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        { slug: "claude-sonnet-4-6", name: "Sonnet 4.6", isCustom: false, capabilities: null },
      ],
    };
    state.environments = [primaryId, siblingId].map((environmentId) => ({
      environmentId,
      label: environmentId,
      connection: { phase: "connected" },
      serverConfig: {
        settings: {
          ...DEFAULT_UNIFIED_SETTINGS,
          sourceControlWriterModelSelection: { instanceId: codexId, model: "gpt-5.4" },
        },
      },
    }));
    state.providers = new Map([
      [primaryId, [codex]],
      [siblingId, [claude]],
    ]);
    const writes: ReturnType<typeof planScopedSettingsPatch>["serverWrites"] = [];
    state.updateSettings.mockImplementation((patch) => {
      const plan = planScopedSettingsPatch(scope(), state.environments, patch);
      writes.push(...plan.serverWrites);
      state.environments = state.environments.map((environment) => {
        const write = plan.serverWrites.find(
          (write) => write.environmentId === environment.environmentId,
        );
        return write && environment.serverConfig
          ? {
              ...environment,
              serverConfig: {
                ...environment.serverConfig,
                settings: applyServerSettingsPatch(environment.serverConfig.settings, write.patch),
              },
            }
          : environment;
      });
      void render();
    });
    await render();

    const picker = page.getByRole("button", { name: "Source control writer model", exact: true });
    const choice = page.getByRole("option", { name: /GPT-5.3 Codex/ });
    await userEvent.click(picker);
    await expect.element(choice).toHaveAttribute("aria-disabled", "true");
    expect(writes).toEqual([]);
    await userEvent.keyboard("{Escape}");

    // The primary now represents an older Claude host that cannot store this row.
    state.environments = state.environments.map((environment) =>
      environment.environmentId === primaryId
        ? {
            ...environment,
            unsupportedSettingKeys: resolveUnsupportedSettingKeys(
              undefined,
              new Set(["sourceControlWriterModelSelection"]),
            ),
            serverConfig: {
              settings: {
                ...DEFAULT_UNIFIED_SETTINGS,
                sourceControlWriterModelSelection: {
                  instanceId: claudeId,
                  model: "claude-sonnet-4-6",
                },
              },
            },
          }
        : environment,
    );
    state.providers = new Map([
      [primaryId, [claude]],
      [siblingId, [codex]],
    ]);
    await render();

    await expect.element(picker).toHaveTextContent("GPT-5.4");
    await expect.element(picker).not.toHaveTextContent("Mixed");
    await userEvent.click(picker);
    await expect.element(choice).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(choice);
    expect(writes.map(({ environmentId, patch }) => ({ environmentId, patch }))).toEqual([
      {
        environmentId: siblingId,
        patch: {
          sourceControlWriterModelSelection: { instanceId: codexId, model: "gpt-5.3-codex" },
        },
      },
    ]);
    await expect.element(picker).toHaveTextContent("GPT-5.3 Codex");
    expect(state.environments[0]!.serverConfig!.settings.sourceControlWriterModelSelection).toEqual(
      {
        instanceId: claudeId,
        model: "claude-sonnet-4-6",
      },
    );
  });

  it("shows the supported environment's editor when the representative cannot store writing style", async () => {
    state.unsupported.add(0);
    state.styles[0] = { ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle };
    await render();

    await expect.element(writeForAll()).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "Custom source control writing instructions" }))
      .toHaveValue("Second environment instructions");
    const templates = page.getByRole("switch", { name: "Follow change request templates" });
    await expect.element(templates).not.toBeChecked();
    await expect.element(templates).toHaveAttribute("aria-checked", "false");
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("resets mixed template preferences without replacing each environment's instructions", async () => {
    const initialInstructions = state.styles.map(({ mode, customInstructions }) => ({
      mode,
      customInstructions,
    }));

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

  it("resets every environment even when the representative already has default instructions", async () => {
    state.styles[0] = { ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle };
    await render();

    await userEvent.click(resetButton("source control writing style"));

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(
      state.styles.map(({ mode, customInstructions }) => ({ mode, customInstructions })),
    ).toEqual(
      [0, 1].map(() => ({
        mode: DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.mode,
        customInstructions: DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.customInstructions,
      })),
    );
    expect(state.styles[1]!.followChangeRequestTemplates).toBe(false);
  });

  it("does not write an untouched bulk draft", async () => {
    const initialStyles = state.styles;
    await userEvent.click(writeForAll());
    await expect.element(bulkEditor()).toHaveValue("");
    await expect.element(applyToAll()).toBeDisabled();

    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.styles).toEqual(initialStyles);
  });

  it("applies edited instructions to every selected environment", async () => {
    await userEvent.click(writeForAll());
    await userEvent.fill(bulkEditor(), "  Keep titles concise.  ");
    await expect.element(applyToAll()).toBeEnabled();
    await userEvent.click(applyToAll());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual([
      "Keep titles concise.",
      "Keep titles concise.",
    ]);
    expect(state.styles.map((style) => style.followChangeRequestTemplates)).toEqual([true, false]);
  });

  it("allows an intentional clear after editing", async () => {
    await userEvent.click(writeForAll());
    await userEvent.fill(bulkEditor(), "Temporary instructions");
    await userEvent.clear(bulkEditor());
    await expect.element(applyToAll()).toBeEnabled();
    await userEvent.click(applyToAll());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual(["", ""]);
  });

  it("shows the plain editor once instructions agree, even while templates differ", async () => {
    await userEvent.click(writeForAll());
    await userEvent.fill(bulkEditor(), "Shared instructions");
    await userEvent.click(applyToAll());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual([
      "Shared instructions",
      "Shared instructions",
    ]);
    await expect.element(writeForAll()).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "Custom source control writing instructions" }))
      .toHaveValue("Shared instructions");
  });
});
