// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));

import { DocumentLanguage, useTranslation } from "./i18n";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
  persistClientSettingsPatch,
} from "./hooks/useSettings";

function Preview() {
  const t = useTranslation();
  return (
    <>
      <DocumentLanguage />
      <output>{t("Settings")}</output>
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  persistence.getClientSettings.mockReset().mockResolvedValue(null);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetClientSettingsPersistenceForTests();
  vi.unstubAllGlobals();
});

describe("reactive interface language", () => {
  it("uses English for an existing installation and updates document language", async () => {
    await act(async () => {
      root.render(<Preview />);
      await ensureClientSettingsHydrated();
    });
    expect(container.textContent).toBe("Settings");
    expect(document.documentElement.lang).toBe("en");
  });

  it("hydrates Chinese, switches immediately, and restores the persisted choice after remount", async () => {
    let durable: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS, interfaceLanguage: "zh-CN" };
    persistence.getClientSettings.mockImplementation(async () => durable);
    persistence.setClientSettings.mockImplementation(async (settings) => {
      durable = settings;
    });
    await act(async () => {
      root.render(<Preview />);
      await ensureClientSettingsHydrated();
    });
    expect(container.textContent).toBe("设置");
    expect(document.documentElement.lang).toBe("zh-CN");
    await act(async () => persistClientSettingsPatch({ interfaceLanguage: "en" }));
    expect(container.textContent).toBe("Settings");
    expect(document.documentElement.lang).toBe("en");
    await act(async () => root.unmount());
    __resetClientSettingsPersistenceForTests();
    root = createRoot(container);
    await act(async () => {
      root.render(<Preview />);
      await ensureClientSettingsHydrated();
    });
    expect(container.textContent).toBe("Settings");
    expect(document.documentElement.lang).toBe("en");
  });
});
