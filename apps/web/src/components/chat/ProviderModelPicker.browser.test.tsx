import {
  AuthSettingsWriteScope,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AuthEnvironmentScope,
  type ModelSelection,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";

const FAVORITES_ENV_ID = EnvironmentId.make("favorites-reorder-test");
const favoritesTestState = vi.hoisted(() => ({
  settingsAtom: null as Atom.Writable<ServerSettings | null> | null,
  canWriteSettings: true,
  savedPatches: [] as Array<ServerSettingsPatch>,
  updateSettingsCommand: null as unknown,
}));

vi.mock(import("../../state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentScope: ((id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      id === FAVORITES_ENV_ID
        ? scope === AuthSettingsWriteScope && favoritesTestState.canWriteSettings
        : actual.useEnvironmentScope(id, scope)) as never,
  };
});

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  favoritesTestState.updateSettingsCommand = actual.serverEnvironment.updateSettings;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: ((id: EnvironmentId) =>
        id === FAVORITES_ENV_ID && favoritesTestState.settingsAtom
          ? favoritesTestState.settingsAtom
          : actual.serverEnvironment.settingsValueAtom(id)) as never,
    },
  };
});

vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command: unknown, options?: unknown) => {
      const real = actual.useAtomCommand(command as never, options as never);
      if (command !== favoritesTestState.updateSettingsCommand) return real;
      return async (input: {
        environmentId: EnvironmentId;
        input: { patch: ServerSettingsPatch };
      }) => {
        if (input.environmentId !== FAVORITES_ENV_ID || !favoritesTestState.settingsAtom) {
          return real(input as never);
        }
        favoritesTestState.savedPatches.push(input.input.patch);
        const current = appAtomRegistry.get(favoritesTestState.settingsAtom);
        if (current) {
          appAtomRegistry.set(
            favoritesTestState.settingsAtom,
            applyServerSettingsPatch(current, input.input.patch),
          );
        }
        return AsyncResult.success(undefined);
      };
    }) as never,
  };
});

import { ProviderModelPicker } from "./ProviderModelPicker";

it("keeps each registry image when adding a model from another ACP agent", async () => {
  const icons = [
    "https://cdn.agentclientprotocol.com/registry/icons/picker-explicit.svg",
    "https://cdn.agentclientprotocol.com/registry/v1/latest/picker-by-id.svg",
  ];
  const cache = await caches.open("t3-acp-registry-icons-v1");
  await using _cachedIcons = {
    async [Symbol.asyncDispose]() {
      await Promise.all(icons.map((url) => cache.delete(url)));
    },
  };
  for (const [index, url] of icons.entries()) {
    await cache.put(
      url,
      new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${11 + index * 6}" height="10"><path d="M0 0h10v10H0z"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } },
      ),
    );
  }
  const entries = deriveProviderInstanceEntries(
    ["First", "Second"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `${name} agent`,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  ).map((entry, index) => ({
    ...entry,
    ...(index === 0 ? { acpRegistryIconUrl: icons[0] } : { acpRegistryAgentId: "picker-by-id" }),
  }));
  const first = { instanceId: entries[0]!.instanceId, model: "first" };
  const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

  function Picker() {
    const [selection, setSelection] = useState<ReadonlyArray<ModelSelection>>([first]);
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={first.instanceId}
        model={first.model}
        {...(selection.length > 1 ? { selectedModels: selection } : {})}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        onToggleModel={(instanceId, model) => setSelection([...selection, { instanceId, model }])}
        onInstanceModelChange={(instanceId, model) => setSelection([{ instanceId, model }])}
      />
    );
  }

  await using screen = await render(<Picker />);
  const imageWidths = () =>
    Array.from(
      screen.container.querySelectorAll<HTMLImageElement>("[data-chat-provider-model-picker] img"),
      (image) => image.naturalWidth,
    );
  await vi.waitFor(() => expect(imageWidths()).toEqual([11]));
  await screen.getByRole("button", { name: "First model", exact: true }).click();
  await page.getByRole("button", { name: "Second agent", exact: true }).click();
  await userEvent.keyboard("{Shift>}");
  try {
    await page.getByRole("option", { name: /Second model/ }).click();
  } finally {
    await userEvent.keyboard("{/Shift}");
  }
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(imageWidths()).toEqual([11, 17]));
});

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker() {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
      />
    );
  }

  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("lists a model reported twice by one provider once, with contiguous jump shortcuts", async () => {
  const instanceId = ProviderInstanceId.make("claude");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      ["a", "b", "c", "c", "d", "d"].map((slug) => ({
        slug,
        name: `Model ${slug.toUpperCase()}`,
      })),
    ],
  ]);
  const keybindings = compileResolvedKeybindingsConfig(
    ([1, 2, 3, 4, 5, 6] as const).map((index) => ({
      key: `mod+${index}`,
      command: `modelPicker.jump.${index}` as const,
      when: "modelPickerOpen",
    })),
  );

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model="a"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      keybindings={keybindings}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Model A/ })).toBeVisible();
  await vi.waitFor(() =>
    expect(
      page
        .getByRole("option")
        .elements()
        .map((row) => [
          row.textContent?.match(/Model [A-Z]/)?.[0],
          row.querySelector("kbd")?.textContent?.slice(-1),
        ]),
    ).toEqual([
      ["Model A", "1"],
      ["Model B", "2"],
      ["Model C", "3"],
      ["Model D", "4"],
    ]),
  );
});

it("opens on the active provider when every favorite belongs to a disabled provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: name === "Codex",
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex, claude] = entries;
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider: claude!.instanceId, model: "claude" }],
  });
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Codex model/ })).toBeVisible();
});

it("keeps the touch keyboard down while choosing a provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex] = entries;
  const matchMedia = window.matchMedia.bind(window);
  using _touch = vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === "(pointer: coarse)"
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList)
      : matchMedia(query),
  );

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  const popup = search.element().closest('[data-slot="popover-popup"]');
  await vi.waitFor(() => expect(document.activeElement).toBe(popup));

  await page.getByRole("button", { name: /^Claude/ }).click();
  await expect.element(page.getByRole("option", { name: /Claude model/ })).toBeVisible();
  await expect.element(search).not.toHaveFocus();
});

it("reorders favorites by drag handle and Alt+Arrow keys while keeping jumps and selection working", async () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claude");
  const disabled = ProviderInstanceId.make("disabled");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId: codex,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: "sol", name: "GPT Sol", isCustom: false, capabilities: {} },
        { slug: "astra", name: "GPT Astra", isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: claude,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [{ slug: "opus", name: "Claude Opus", isCustom: false, capabilities: {} }],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: disabled,
      driver: ProviderDriverKind.make("cursor"),
      enabled: false,
      installed: true,
      version: null,
      status: "disabled",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [{ slug: "hidden-fav", name: "Disabled Model", isCustom: false, capabilities: {} }],
      slashCommands: [],
      skills: [],
    },
  ]);

  const initialFavorites = [
    { provider: codex, model: "sol" },
    { provider: disabled, model: "hidden-fav" },
    { provider: claude, model: "opus" },
    { provider: codex, model: "astra" },
  ];
  const settingsAtom = Atom.make<ServerSettings | null>({
    ...DEFAULT_SERVER_SETTINGS,
    favorites: initialFavorites,
    providerModelPreferences: {},
  });
  favoritesTestState.settingsAtom = settingsAtom;
  favoritesTestState.canWriteSettings = true;
  favoritesTestState.savedPatches = [];
  using _favoritesReset = {
    [Symbol.dispose]() {
      favoritesTestState.settingsAtom = null;
      favoritesTestState.canWriteSettings = true;
      favoritesTestState.savedPatches = [];
    },
  };

  const keybindings = compileResolvedKeybindingsConfig(
    ([1, 2, 3] as const).map((index) => ({
      key: `mod+${index}`,
      command: `modelPicker.jump.${index}` as const,
      when: "modelPickerOpen",
    })),
  );
  const onInstanceModelChange = vi.fn();

  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ProviderModelPicker
        environmentId={FAVORITES_ENV_ID}
        activeInstanceId={codex}
        model="sol"
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
        keybindings={keybindings}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={onInstanceModelChange}
      />
    </RegistryContext.Provider>,
  );

  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /GPT Sol/ })).toBeVisible();

  const optionOrder = () =>
    page
      .getByRole("option")
      .elements()
      .map((row) => [
        row.textContent?.match(/GPT Sol|Claude Opus|GPT Astra/)?.[0],
        row.querySelector("kbd")?.textContent?.slice(-1),
      ]);

  // Favorites appear in saved favorites order (cross-provider), each with a visible drag handle.
  expect(optionOrder()).toEqual([
    ["GPT Sol", "1"],
    ["Claude Opus", "2"],
    ["GPT Astra", "3"],
  ]);
  expect(document.querySelectorAll("[data-favorite-drag-handle]").length).toBe(3);

  // Drag the third favorite (GPT Astra) onto the first row (GPT Sol) via real browser pointer input.
  const firstRow = page.getByRole("option", { name: /GPT Sol/ }).element();
  const thirdRow = page.getByRole("option", { name: /GPT Astra/ }).element();
  const firstSortable = firstRow.closest<HTMLElement>("[data-model-picker-sortable-index]")!;
  const thirdSortable = thirdRow.closest<HTMLElement>("[data-model-picker-sortable-index]")!;
  const thirdHandle = thirdRow.querySelector<HTMLElement>("[data-favorite-drag-handle]")!;
  const startRect = thirdHandle.getBoundingClientRect();
  const targetRect = firstRow.getBoundingClientRect();
  const frame = window.frameElement?.getBoundingClientRect();
  const startX = startRect.left + startRect.width / 2;
  const startY = startRect.top + startRect.height / 2;
  const targetY = targetRect.top + targetRect.height / 2;
  const mouse = (
    type: "mousePressed" | "mouseMoved" | "mouseReleased",
    x: number,
    y: number,
    buttons: number,
  ) =>
    cdp().send("Input.dispatchMouseEvent", {
      type,
      x: x + (frame?.left ?? 0),
      y: y + (frame?.top ?? 0),
      button: type === "mouseMoved" ? "none" : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });

  await mouse("mouseMoved", startX, startY, 0);
  await mouse("mousePressed", startX, startY, 1);
  await mouse("mouseMoved", startX, startY - 8, 1);
  await vi.waitFor(() => expect(thirdSortable.dataset.dragging).toBe("true"));
  await mouse("mouseMoved", startX, targetY, 1);
  await vi.waitFor(() =>
    expect(firstSortable.style.transform).toMatch(/translate3d\(0px,\s*[1-9]/),
  );
  await mouse("mouseReleased", startX, targetY, 0);

  await vi.waitFor(() =>
    expect(optionOrder()).toEqual([
      ["GPT Astra", "1"],
      ["GPT Sol", "2"],
      ["Claude Opus", "3"],
    ]),
  );
  // Dragging did not accidentally select the model or close the picker.
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toBeVisible();
  await expect.element(search).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
  expect(onInstanceModelChange).not.toHaveBeenCalled();
  // Hidden/disabled favorites stay in their original slot when visible favorites reorder.
  expect(favoritesTestState.savedPatches.at(-1)).toEqual({
    reorderModelFavorites: [
      { provider: codex, model: "astra" },
      { provider: disabled, model: "hidden-fav" },
      { provider: codex, model: "sol" },
      { provider: claude, model: "opus" },
    ],
  });

  // Keyboard reorder: highlight the first item (GPT Astra) and move it down twice with Alt+ArrowDown.
  await expect.element(search).toHaveFocus();
  await page.getByRole("option", { name: /GPT Astra/ }).hover();
  await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
  await vi.waitFor(() =>
    expect(optionOrder()).toEqual([
      ["GPT Sol", "1"],
      ["GPT Astra", "2"],
      ["Claude Opus", "3"],
    ]),
  );
  await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
  await vi.waitFor(() =>
    expect(optionOrder()).toEqual([
      ["GPT Sol", "1"],
      ["Claude Opus", "2"],
      ["GPT Astra", "3"],
    ]),
  );

  // Clicking a favorite row still selects the model normally.
  await page.getByRole("option", { name: /Claude Opus/ }).click();
  expect(onInstanceModelChange).toHaveBeenCalledWith(claude, "opus");
});
