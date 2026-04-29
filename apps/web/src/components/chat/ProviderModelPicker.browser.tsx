import { type ProviderKind, type ServerProvider } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderModelPicker } from "./ProviderModelPicker";
import { getCustomModelOptionsByProvider } from "../../modelSelection";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { __resetClientSettingsPersistenceForTests } from "../../hooks/useSettings";
import { __resetLocalApiForTests } from "../../localApi";

// Mock the environments/runtime module to provide a mock primary environment connection
vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: {
        getConfig: vi.fn(),
        updateSettings: vi.fn(),
      },
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
    resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    addSavedEnvironment: vi.fn(),
    disconnectSavedEnvironment: vi.fn(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: vi.fn(),
    startEnvironmentConnectionService: vi.fn(),
    subscribeEnvironmentConnections: () => () => {},
    useSavedEnvironmentRegistryStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "gpt-5-codex",
        name: "GPT-5 Codex",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoningEffort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("fastMode", "Fast Mode"),
          ],
        }),
      },
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoningEffort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("fastMode", "Fast Mode"),
          ],
        }),
      },
    ],
  },
  {
    provider: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
              { id: "max", label: "max" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
              { id: "max", label: "max" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
    ],
  },
];

function buildCodexProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    provider: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
    slashCommands: [],
    skills: [],
  };
}

function buildOpenCodeProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    provider: "opencode",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
    slashCommands: [],
    skills: [],
  };
}

async function mountPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  triggerVariant?: "ghost" | "outline";
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onProviderModelChange = vi.fn();
  const providers = props.providers ?? TEST_PROVIDERS;
  const modelOptionsByProvider = getCustomModelOptionsByProvider(
    DEFAULT_UNIFIED_SETTINGS,
    providers,
    props.provider,
    props.model,
  );
  const screen = await render(
    <ProviderModelPicker
      provider={props.provider}
      model={props.model}
      lockedProvider={props.lockedProvider}
      providers={providers}
      modelOptionsByProvider={modelOptionsByProvider}
      triggerVariant={props.triggerVariant}
      onProviderModelChange={onProviderModelChange}
    />,
    { container: host },
  );

  return {
    onProviderModelChange,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function getModelPickerListElement() {
  const modelPickerList = document.querySelector<HTMLElement>(".model-picker-list");
  expect(modelPickerList).not.toBeNull();
  return modelPickerList!;
}

function getModelPickerListText() {
  return getModelPickerListElement().textContent ?? "";
}

function getVisibleModelNames() {
  return Array.from(getModelPickerListElement().querySelectorAll<HTMLDivElement>("div.font-medium"))
    .map((element) => element.textContent?.replace(/New$/u, "").trim() ?? "")
    .filter((text) => text.length > 0);
}

function getSidebarProviderOrder() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-model-picker-provider]")).map(
    (element) => element.dataset.modelPickerProvider ?? "",
  );
}

describe("ProviderModelPicker", () => {
  beforeEach(async () => {
    // Reset test environment before each test
    localStorage.clear();
    await __resetLocalApiForTests();
    __resetClientSettingsPersistenceForTests();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();
    await __resetLocalApiForTests();
    __resetClientSettingsPersistenceForTests();
  });

  it("shows provider sidebar in unlocked mode", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).not.toContain("Codex");
        expect(text).toContain("Claude");
        expect(text).toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows favorites first in the provider sidebar", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder().slice(0, 3)).toEqual([
          "favorites",
          "codex",
          "claudeAgent",
        ]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters models by selected provider in sidebar", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      // Start with Claude models visible
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).not.toContain("GPT-5 Codex");
        expect(text).toContain("Claude Opus 4.6");
      });

      // Click on Codex provider in sidebar
      await vi.waitFor(() => {
        expect(document.querySelector('[data-model-picker-provider="codex"]')).not.toBeNull();
      });
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      // Now should only show Codex models
      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("GPT-5 Codex");
        expect(listText).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("focuses the search input after selecting a sidebar provider", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-model-picker-provider="codex"]')).not.toBeNull();
      });
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows locked provider header and only its models in locked mode", async () => {
    localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [
          { provider: "codex", model: "gpt-5-codex" },
          { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        ],
      }),
    );

    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        // Should show locked provider label
        expect(text).toContain("Claude");
        expect(getVisibleModelNames()).toEqual([
          "Claude Sonnet 4.6",
          "Claude Opus 4.6",
          "Claude Haiku 4.5",
        ]);
      });
    } finally {
      localStorage.removeItem("t3code:client-settings:v1");
      await mounted.cleanup();
    }
  });

  it("falls back to the active provider's first model when props.model belongs to another provider (#1982)", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onProviderModelChange = vi.fn();
    const modelOptionsByProvider = {
      claudeAgent: [
        { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ],
      codex: [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }],
      cursor: [],
      opencode: [],
    } as const;
    const screen = await render(
      <ProviderModelPicker
        provider="claudeAgent"
        model="gpt-5-codex"
        lockedProvider={null}
        providers={TEST_PROVIDERS}
        modelOptionsByProvider={modelOptionsByProvider}
        onProviderModelChange={onProviderModelChange}
      />,
      { container: host },
    );

    try {
      const trigger = document.querySelector<HTMLElement>(
        '[data-chat-provider-model-picker="true"]',
      );
      expect(trigger).not.toBeNull();
      const label = trigger?.textContent ?? "";
      expect(label).not.toContain("gpt-5-codex");
      expect(label).toContain("Claude Opus 4.6");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("uses the trigger label for locked opencode rows", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildOpenCodeProvider([
        {
          slug: "github-copilot/claude-opus-4.5",
          name: "Claude Opus 4.5",
          subProvider: "GitHub Copilot",
          shortName: "Opus 4.5",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
    ];
    const mounted = await mountPicker({
      provider: "opencode",
      model: "github-copilot/claude-opus-4.5",
      lockedProvider: "opencode",
      providers,
    });

    try {
      await vi.waitFor(() => {
        const trigger = document.querySelector<HTMLElement>(
          '[data-chat-provider-model-picker="true"]',
        );
        expect(trigger?.textContent).toContain("GitHub Copilot");
        expect(trigger?.textContent).toContain("Opus 4.5");
      });

      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["GitHub Copilot · Opus 4.5"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches models by name in flat list", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
        expect(text).not.toContain("GPT-5 Codex");
      });

      // Find and type in search box
      const searchInput = page.getByPlaceholder("Search models...");
      await searchInput.fill("claude");

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
        expect(text).not.toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports arrow-key navigation in the model picker", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();

      const searchInput = page.getByPlaceholder("Search models...");
      await userEvent.click(searchInput);
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const highlightedItem = document.querySelector<HTMLElement>(
          '[data-slot="combobox-item"][data-highlighted]',
        );
        expect(highlightedItem).not.toBeNull();
        expect(highlightedItem?.textContent).toContain("Claude Opus 4.6");
      });
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const highlightedItem = document.querySelector<HTMLElement>(
          '[data-slot="combobox-item"][data-highlighted]',
        );
        expect(highlightedItem).not.toBeNull();
        expect(highlightedItem?.textContent).toContain("Claude Sonnet 4.6");
      });
      await userEvent.keyboard("{Enter}");

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the provider sidebar while searching", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder().length).toBeGreaterThan(0);
      });

      await page.getByPlaceholder("Search models...").fill("cla");

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder()).toEqual([]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes the picker when escape is pressed in search", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      const searchInput = page.getByPlaceholder("Search models...");
      await searchInput.click();
      const searchInputElement = document.querySelector<HTMLInputElement>(
        'input[placeholder="Search models..."]',
      );
      expect(searchInputElement).not.toBeNull();
      searchInputElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches models by provider name", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
        expect(text).not.toContain("GPT-5 Codex");
      });

      // Search by provider name
      const searchInput = page.getByPlaceholder("Search models...");
      await searchInput.fill("codex");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("GPT-5 Codex");
        expect(listText).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("matches fuzzy multi-token queries across provider and model text", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5-codex",
          name: "GPT-5 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      buildOpenCodeProvider([
        {
          slug: "github-copilot/claude-opus-4.7",
          name: "Claude Opus 4.7",
          subProvider: "GitHub Copilot",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
    ];
    const mounted = await mountPicker({
      provider: "opencode",
      model: "github-copilot/claude-opus-4.7",
      lockedProvider: null,
      providers,
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models...").fill("coplt op");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("Claude Opus 4.7");
        expect(listText).not.toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders each search result with its own provider branding", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildOpenCodeProvider([
        {
          slug: "github-copilot/claude-opus-4.7",
          name: "Claude Opus 4.7",
          subProvider: "GitHub Copilot",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
      {
        ...TEST_PROVIDERS[1]!,
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("effort", "Reasoning", [
                  { id: "low", label: "low" },
                  { id: "medium", label: "medium", isDefault: true },
                  { id: "high", label: "high" },
                  { id: "max", label: "max" },
                ]),
                booleanDescriptor("thinking", "Thinking"),
              ],
            }),
          },
        ],
      },
    ];
    const mounted = await mountPicker({
      provider: "opencode",
      model: "github-copilot/claude-opus-4.7",
      lockedProvider: null,
      providers,
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models...").fill("opus");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("OpenCode · GitHub Copilot");
        expect(listText).toContain("Claude");
        expect(listText).not.toContain("OpenCodeClaude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles favorite stars when clicked", async () => {
    localStorage.removeItem("t3code:client-settings:v1");

    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
      });

      const getFirstStarButton = () => {
        const starButton = document.querySelector<HTMLButtonElement>(
          'button[aria-label*="favorites"]',
        );
        expect(starButton).not.toBeNull();
        return starButton!;
      };

      const firstStar = getFirstStarButton();
      const initialAriaLabel = firstStar.getAttribute("aria-label");
      expect(
        initialAriaLabel === "Add to favorites" || initialAriaLabel === "Remove from favorites",
      ).toBe(true);

      await page.getByRole("button", { name: initialAriaLabel! }).first().click();

      const expectedAriaLabel =
        initialAriaLabel === "Add to favorites" ? "Remove from favorites" : "Add to favorites";

      await vi.waitFor(() => {
        expect(getFirstStarButton().getAttribute("aria-label")).toBe(expectedAriaLabel);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("t3code:client-settings:v1");
    }
  });

  it("does not duplicate favorited models across favorites and all models sections", async () => {
    localStorage.removeItem("t3code:client-settings:v1");

    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
      });

      const favoriteButton = page.getByRole("button", {
        name: "Add to favorites",
      });
      await favoriteButton.first().click();

      await vi.waitFor(async () => {
        const favoritedModelRows = Array.from(
          getModelPickerListElement().querySelectorAll<HTMLDivElement>("div.font-medium"),
        ).filter((element) => element.textContent?.trim() === "Claude Opus 4.6");
        expect(favoritedModelRows.length).toBe(1);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("t3code:client-settings:v1");
    }
  });

  it("shows favorited models first within the selected provider list", async () => {
    localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "codex", model: "gpt-5.3-codex" }],
      }),
    );

    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames().slice(0, 2)).toEqual(["GPT-5.3 Codex", "GPT-5 Codex"]);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("t3code:client-settings:v1");
    }
  });

  it("reorders favorited models from the favorites list", async () => {
    localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [
          { provider: "codex", model: "gpt-5-codex" },
          { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        ],
      }),
    );

    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Favorites", exact: true }).click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames().slice(0, 2)).toEqual(["GPT-5 Codex", "Claude Sonnet 4.6"]);
      });

      await page
        .getByRole("button", { name: "Move Claude Sonnet 4.6 up in favorites", exact: true })
        .click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames().slice(0, 2)).toEqual(["Claude Sonnet 4.6", "GPT-5 Codex"]);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("t3code:client-settings:v1");
    }
  });

  it("does not show hidden models in the picker", async () => {
    localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        hiddenModels: [{ provider: "codex", model: "gpt-5.3-codex" }],
      }),
    );

    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      await vi.waitFor(() => {
        const visibleModelNames = getVisibleModelNames();
        expect(visibleModelNames).toContain("GPT-5 Codex");
        expect(visibleModelNames).not.toContain("GPT-5.3 Codex");
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("t3code:client-settings:v1");
    }
  });

  it("dispatches callback with correct provider and model when selected", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Sonnet 4.6");
      });

      // Click on a model
      const modelRow = page.getByText("Claude Sonnet 4.6").first();
      await modelRow.click();

      // Verify callback was called with correct values
      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("only shows codex spark when the server reports it", async () => {
    const providersWithoutSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];
    const providersWithSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
        {
          slug: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];

    const hidden = await mountPicker({
      provider: "codex",
      model: "gpt-5.3-codex",
      lockedProvider: null,
      providers: providersWithoutSpark,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5.3 Codex");
        expect(text).not.toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await hidden.cleanup();
    }

    const visible = await mountPicker({
      provider: "codex",
      model: "gpt-5.3-codex",
      lockedProvider: null,
      providers: providersWithSpark,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await visible.cleanup();
    }
  });

  it("shows disabled providers grayed out in sidebar", async () => {
    const disabledProviders = TEST_PROVIDERS.slice();
    const claudeIndex = disabledProviders.findIndex(
      (provider) => provider.provider === "claudeAgent",
    );
    if (claudeIndex >= 0) {
      const claudeProvider = disabledProviders[claudeIndex]!;
      disabledProviders[claudeIndex] = {
        ...claudeProvider,
        enabled: false,
        status: "disabled",
      };
    }

    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: disabledProviders,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5 Codex");
        // Disabled provider should not have its models shown
        expect(text).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("accepts outline trigger styling", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      triggerVariant: "outline",
    });

    try {
      const button = document.querySelector("button");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Expected picker trigger button to be rendered.");
      }
      expect(button.className).toContain("border-input");
      expect(button.className).toContain("bg-popover");
    } finally {
      await mounted.cleanup();
    }
  });
});
