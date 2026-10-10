// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import type { LanguagePreference } from "@t3tools/client-runtime/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  locales: ["ja-JP", "zh-CN", "en-US"],
  result: undefined as unknown,
  listener: null as null | ((state: string) => void),
  remove: vi.fn(),
}));
vi.mock("expo-localization", () => ({
  getLocales: () => native.locales.map((languageTag) => ({ languageTag })),
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_: string, listener: (state: string) => void) => {
      native.listener = listener;
      return { remove: native.remove };
    },
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => native.result }));
vi.mock("./state/preferences", () => ({ mobilePreferencesAtom: {} }));

import { changeLanguage, i18n, LanguageSync } from "./i18n";
let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => root.render(<LanguageSync />));
}
function loaded(languagePreference?: LanguagePreference) {
  native.result = AsyncResult.success({ languagePreference });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.locales = ["ja-JP", "zh-CN", "en-US"];
  native.result = AsyncResult.initial();
  native.listener = null;
  native.remove.mockClear();
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

it("does not apply the device default before saved preferences load", async () => {
  const changed = vi.fn();
  i18n.on("languageChanged", changed);
  try {
    await render();
    expect(i18n.resolvedLanguage).toBe("en");
    expect(changed).not.toHaveBeenCalled();
    loaded("en");
    await render();
    expect(i18n.resolvedLanguage).toBe("en");
    expect(changed).not.toHaveBeenCalled();
  } finally {
    i18n.off("languageChanged", changed);
  }
});
it("negotiates the entire UI locale list after hydration", async () => {
  await render();
  loaded();
  await render();
  expect(i18n.t("settings.language.title")).toBe("语言");
  expect(i18n.resolvedLanguage).toBe("zh");
});
it("re-reads locales on foregrounding only while following the system", async () => {
  loaded("system");
  await render();
  expect(i18n.resolvedLanguage).toBe("zh");
  native.locales = ["en-US"];
  await act(async () => native.listener?.("background"));
  expect(i18n.resolvedLanguage).toBe("zh");
  await act(async () => native.listener?.("active"));
  expect(i18n.resolvedLanguage).toBe("en");
  loaded("zh");
  await render();
  expect(native.remove).toHaveBeenCalledOnce();
  expect(i18n.resolvedLanguage).toBe("zh");
  loaded("system");
  await render();
  expect(i18n.resolvedLanguage).toBe("en");
  await act(async () => root.render(null));
  expect(native.remove).toHaveBeenCalledTimes(2);
});
