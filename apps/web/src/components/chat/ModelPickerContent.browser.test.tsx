import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const testState = vi.hoisted(() => ({
  favorites: [] as ReadonlyArray<{ provider: string; model: string }>,
}));

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: (() => ({
    favorites: testState.favorites,
    providerModelPreferences: {},
  })) as never,
  useToggleEnvironmentModelFavorite: (() => vi.fn()) as never,
}));

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerContent } from "./ModelPickerContent";

function setup(favorites: typeof testState.favorites) {
  testState.favorites = favorites;
}

function provider(driver: string, enabled: boolean): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

const codexId = ProviderInstanceId.make("codex");
const opencodeId = ProviderInstanceId.make("opencode");

function picker() {
  return (
    <ModelPickerContent
      environmentId={null}
      activeInstanceId={codexId}
      model="gpt-5.5"
      lockedProvider={null}
      instanceEntries={deriveProviderInstanceEntries([
        provider("codex", true),
        provider("opencode", false),
      ])}
      keybindings={[]}
      modelOptionsByInstance={
        new Map([
          [codexId, [{ slug: "gpt-5.5", name: "GPT-5.5" }]],
          [opencodeId, [{ slug: "open-model", name: "Open Model" }]],
        ])
      }
      terminalOpen={false}
      onInstanceModelChange={vi.fn()}
    />
  );
}

describe("ModelPickerContent default tab", () => {
  it("opens on the active provider when every favorite belongs to a disabled provider", async () => {
    setup([{ provider: "opencode", model: "open-model" }]);
    await using screen = await render(picker());

    await expect
      .element(screen.getByRole("button", { name: "Favorites" }))
      .toHaveAttribute("aria-pressed", "false");
    await expect
      .element(screen.getByRole("button", { name: "Codex" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("GPT-5.5")).toBeVisible();
    await expect.element(screen.getByText("No models found")).not.toBeInTheDocument();
  });

  it("opens on Favorites when at least one favorite is available", async () => {
    setup([
      { provider: "opencode", model: "open-model" },
      { provider: "codex", model: "gpt-5.5" },
    ]);
    await using screen = await render(picker());

    await expect
      .element(screen.getByRole("button", { name: "Favorites" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("GPT-5.5")).toBeVisible();
  });
});
