// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ settings: {} as UnifiedSettings }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => (patch: Partial<UnifiedSettings>) => {
    state.settings = { ...state.settings, ...patch };
  },
}));
vi.mock("./useScopedModelAvailability", () => ({ useScopedModelDisabledReason: () => null }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
  }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: UnifiedSettings) => unknown) => selector(state.settings),
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("./settingsLayout", async (original) => ({
  ...(await original<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  // Other settings are outside this test's client-only language surface.
  SettingsRow: ({
    id,
    title,
    resetAction,
    control,
  }: {
    id: string;
    title: ReactNode;
    resetAction: ReactNode;
    control: ReactNode;
  }) =>
    id === "language" ? (
      <section>
        {title}
        {resetAction}
        {control}
      </section>
    ) : null,
}));
import { GeneralSettingsPanel } from "./SettingsPanels";
import { changeLanguage, LanguageSync } from "../../i18n";
let container: HTMLDivElement;
let root: Root;
const makeRouter = () =>
  createRouter({
    routeTree: createRootRoute({ component: GeneralSettingsPanel }),
    history: createMemoryHistory(),
  });
let router: ReturnType<typeof makeRouter>;
async function render() {
  await act(async () =>
    root.render(
      <>
        <LanguageSync />
        <RouterProvider router={router} />
      </>,
    ),
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, languagePreference: "zh" };
  await changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  router = makeRouter();
  await router.load();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await changeLanguage("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("localizes the reset accessible name and tooltip and returns to the system language", async () => {
  await render();
  const reset = container.querySelector<HTMLButtonElement>(
    'button[aria-label="将语言重置为默认值"]',
  );
  expect(reset).not.toBeNull();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    reset!.focus();
  });
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "重置为默认值",
  );
  await act(async () => reset!.click());
  await render();
  expect(state.settings.languagePreference).toBe("system");
  expect(container.textContent).toContain("System default");
  expect(container.querySelector('button[aria-label="将语言重置为默认值"]')).toBeNull();
  expect(document.documentElement.lang).toBe("en");
});
