// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import type { LanguagePreference } from "@t3tools/client-runtime/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  result: undefined as unknown,
  save: vi.fn(),
  header: "",
}));
vi.mock("expo-localization", () => ({ getLocales: () => [{ languageTag: "en-US" }] }));
vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove: vi.fn() }) } }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => state.result,
  useAtomSet: () => state.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: ({ options }: { options: { title: string } }) => {
    state.header = options.title;
    return null;
  },
}));
vi.mock("../../components/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ title, children }: { title: string; children: ReactNode }) => (
    <>
      {title}
      {children}
    </>
  ),
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <>
      {title}
      {children}
    </>
  ),
}));
vi.mock("./components/SettingsChoiceRow", () => ({
  SettingsChoiceRow: ({
    label,
    description,
    onPress,
    disabled,
  }: {
    label: string;
    description: string;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
      {description}
    </button>
  ),
}));

import { SettingsLanguageRouteScreen } from "./SettingsLanguageRouteScreen";
import { changeLanguage, LanguageSync } from "../../i18n";
let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () =>
    root.render(
      <>
        <LanguageSync />
        <SettingsLanguageRouteScreen />
      </>,
    ),
  );
}
async function choose(label: string) {
  const button = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith(label),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await render();
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.result = AsyncResult.success({ languagePreference: "en" });
  state.save
    .mockReset()
    .mockImplementation(({ languagePreference }: { languagePreference: LanguagePreference }) => {
      state.result = AsyncResult.success({ languagePreference });
    });
  await changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await changeLanguage("en");
  vi.unstubAllGlobals();
});
it("shows a visible language change after a successful save and supports returning to system", async () => {
  await render();
  await choose("中文");
  expect(state.header).toBe("语言");
  expect(container.textContent).toContain("跟随设备语言。");
  await choose("跟随系统");
  expect(state.header).toBe("Language");
  expect(container.textContent).toContain("Follow the device language.");
});
it("keeps choices disabled before preferences load", async () => {
  state.result = AsyncResult.initial();
  await render();
  expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  await choose("中文");
  expect(state.save).not.toHaveBeenCalled();
});
it("does not change the displayed language when saving fails to update preferences", async () => {
  state.save.mockImplementation(() => {});
  await render();
  await choose("中文");
  expect(state.header).toBe("Language");
  expect(container.textContent).not.toContain("跟随设备语言。");
});
