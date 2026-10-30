import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettingsPatch,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch, resolveModelPreferences } from "@t3tools/shared/serverSettings";
import { Atom, AtomRegistry } from "effect/reactivity";
import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerContent } from "./ModelPickerContent";

const state = vi.hoisted(() => ({
  settings: null as unknown as Atom.Writable<UnifiedSettings>,
  canWrite: true,
  save: vi.fn(),
  favorite: vi.fn(),
}));

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => useAtomValue(state.settings),
  useUpdateEnvironmentModelPreferences:
    (environmentId: EnvironmentId | null) => (patch: ServerSettingsPatch) =>
      state.save(environmentId, patch),
  useToggleEnvironmentModelFavorite: () => state.favorite,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canWrite,
}));
vi.mock(import("~/state/server"), async (original) => ({
  ...(await original()),
  primaryServerKeybindingsAtom: Atom.make([]),
}));

const environmentId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("codex_work");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: ["gpt-6-astra", "gpt-6-luna"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: {},
  })),
  slashCommands: [],
  skills: [],
};
const entries = deriveProviderInstanceEntries([provider]);

function Picker({ onSelect, onClose }: { onSelect: () => void; onClose: () => void }) {
  const settings = useAtomValue(state.settings);
  const searchInputRef = useRef<HTMLInputElement>(null);
  return (
    <ModelPickerContent
      environmentId={environmentId}
      activeInstanceId={instanceId}
      model="gpt-6-astra"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={
        new Map([[instanceId, getAppModelOptionsForInstance(settings, entries[0]!)]])
      }
      terminalOpen={false}
      keybindings={[]}
      onInstanceModelChange={onSelect}
      onRequestClose={onClose}
      searchInputRef={searchInputRef}
    />
  );
}

function setup() {
  state.canWrite = true;
  state.favorite.mockReset();
  state.save.mockReset();
  state.settings = Atom.make<UnifiedSettings>({
    ...DEFAULT_UNIFIED_SETTINGS,
    favorites: [{ provider: instanceId, model: "gpt-6-astra" }],
    providerInstances: {
      [instanceId]: { driver: provider.driver, config: { customModels: ["custom-model"] } },
    },
  });
  const registry = AtomRegistry.make();
  state.save.mockImplementation(async (_environmentId, patch: ServerSettingsPatch) => {
    const current = registry.get(state.settings);
    const next = applyServerSettingsPatch(current, patch);
    registry.set(state.settings, {
      ...current,
      ...next,
      ...resolveModelPreferences(next, current),
    });
  });
  const onSelect = vi.fn();
  const onClose = vi.fn();
  return {
    registry,
    onSelect,
    onClose,
    ui: (
      <RegistryContext.Provider value={registry}>
        <Picker onSelect={onSelect} onClose={onClose} />
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("hiding models in the picker", () => {
  it("hides a selected favorite without selecting or closing, and can restore it", async () => {
    using test = setup();
    await using screen = await render(test.ui);
    await screen.getByRole("button", { name: "Hide gpt-6-astra from picker" }).click();

    expect(state.save).toHaveBeenCalledExactlyOnceWith(environmentId, {
      setModelsHidden: [{ provider: instanceId, model: "gpt-6-astra", hidden: true }],
    });
    await expect.element(screen.getByText("No favorites yet")).toBeVisible();
    await expect.element(screen.getByPlaceholder("Search models...")).toHaveFocus();
    expect(test.onSelect).not.toHaveBeenCalled();
    expect(test.onClose).not.toHaveBeenCalled();
    expect(state.favorite).not.toHaveBeenCalled();
    expect(test.registry.get(state.settings).favorites).toEqual([
      { provider: instanceId, model: "gpt-6-astra" },
    ]);

    await act(() =>
      state.save(environmentId, {
        setModelsHidden: [{ provider: instanceId, model: "gpt-6-astra", hidden: false }],
      }),
    );
    await expect
      .element(
        screen.getByRole("button", {
          name: "Hide gpt-6-astra from picker",
        }),
      )
      .toBeVisible();
  });

  it.each(["{Enter}", " "])("hides from search with %s without selecting the row", async (key) => {
    using test = setup();
    await using screen = await render(test.ui);
    await screen.getByPlaceholder("Search models...").fill("luna");
    await act(() =>
      screen.getByRole("button", { name: "Hide gpt-6-luna from picker" }).element().focus(),
    );
    await userEvent.keyboard(key);
    await expect.element(screen.getByText("No models found")).toBeVisible();
    await expect.element(screen.getByPlaceholder("Search models...")).toHaveFocus();
    expect(test.onSelect).not.toHaveBeenCalled();
    expect(test.onClose).not.toHaveBeenCalled();
  });

  it("keeps custom models visible and disallows hiding without settings permission", async () => {
    using test = setup();
    await using screen = await render(test.ui);
    await screen.getByPlaceholder("Search models...").fill("custom-model");
    await expect
      .element(
        screen.getByRole("button", {
          name: "Hide custom-model from picker",
        }),
      )
      .toBeDisabled();

    state.canWrite = false;
    await screen.getByPlaceholder("Search models...").fill("luna");
    await expect
      .element(
        screen.getByRole("button", {
          name: "Hide gpt-6-luna from picker",
        }),
      )
      .toBeDisabled();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("keeps a model visible when its settings write does not succeed", async () => {
    using test = setup();
    state.save.mockResolvedValue(undefined);
    await using screen = await render(test.ui);
    await screen.getByRole("button", { name: "Hide gpt-6-astra from picker" }).click();
    await expect
      .element(
        screen.getByRole("button", {
          name: "Hide gpt-6-astra from picker",
        }),
      )
      .toBeVisible();
    expect(test.onSelect).not.toHaveBeenCalled();
    expect(test.onClose).not.toHaveBeenCalled();
  });
});
