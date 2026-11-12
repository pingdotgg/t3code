import { EnvironmentId, type ServerConfig, type UiLocale } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../test/render";
import { UiLocaleSettingsRow } from "./components/settings/UiLocaleSettingsRow";
import { writeUiLocale } from "./hooks/useUiLocale";
import { AppAtomRegistryProvider, appAtomRegistry } from "./rpc/atomRegistry";
import { serverEnvironment } from "./state/server";
import { nextUiLocale, resolveUiLanguage, startUiLocaleSync } from "./i18n";

const state = vi.hoisted(() => ({
  configs: new Map<EnvironmentId, ServerConfig>(),
  configsAtom: null as
    | null
    | import("effect/reactivity").Atom.Writable<ReadonlyMap<EnvironmentId, ServerConfig>>,
}));

// The sync and the settings row both read server settings through this atom.
vi.mock(import("./state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const atom = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(state.configs);
  state.configsAtom = atom;
  return {
    ...(await original()),
    environmentServerConfigsAtom: atom,
    serverEnvironment: { updateSettings: { label: "serverEnvironment.updateSettings" } } as never,
  };
});
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: vi.fn(),
}));

const environmentId = EnvironmentId.make("primary");

function setConfigs(uiLocale: UiLocale): void {
  state.configs = new Map([[environmentId, { settings: { uiLocale } } as unknown as ServerConfig]]);
  if (state.configsAtom) appAtomRegistry.set(state.configsAtom, state.configs);
}

describe("resolveUiLanguage", () => {
  it("maps explicit locales directly", () => {
    expect(resolveUiLanguage("en", [])).toBe("en");
    expect(resolveUiLanguage("zh-Hans", [])).toBe("zh-Hans");
  });

  it("follows the device language for system", () => {
    expect(resolveUiLanguage("system", ["en-US", "en"])).toBe("en");
    expect(resolveUiLanguage("system", ["zh-Hans-CN", "en"])).toBe("zh-Hans");
    expect(resolveUiLanguage("system", ["zh-SG"])).toBe("zh-Hans");
    expect(resolveUiLanguage("system", ["zh"])).toBe("zh-Hans");
  });

  it("falls back to English when no device language is supported", () => {
    expect(resolveUiLanguage("system", ["fr-FR", "de-DE"])).toBe("en");
    expect(resolveUiLanguage("system", ["zh-Hant-TW", "zh-HK"])).toBe("en");
    expect(resolveUiLanguage("system", [])).toBe("en");
  });
});

describe("nextUiLocale", () => {
  it("cycles system, en, zh-Hans", () => {
    expect(nextUiLocale("system")).toBe("en");
    expect(nextUiLocale("en")).toBe("zh-Hans");
    expect(nextUiLocale("zh-Hans")).toBe("system");
  });
});

describe("uiLocale setting", () => {
  it("switches the rendered language when the synced server setting changes", async () => {
    setConfigs("en");
    using _sync = { [Symbol.dispose]: startUiLocaleSync() };
    await using screen = await render(
      <AppAtomRegistryProvider>
        <UiLocaleSettingsRow />
      </AppAtomRegistryProvider>,
    );
    expect(screen.getByText("Interface language")).toBeTruthy();
    expect(screen.getByText("English")).toBeTruthy();

    await act(async () => {
      setConfigs("zh-Hans");
    });
    await vi.waitFor(() => {
      expect(screen.getByText("界面语言")).toBeTruthy();
    });
    expect(screen.getByText("跟随系统")).toBeTruthy();

    await act(async () => {
      setConfigs("en");
    });
    await vi.waitFor(() => {
      expect(screen.getByText("Interface language")).toBeTruthy();
    });
  });

  it("writes the picked locale to every connected environment", () => {
    setConfigs("en");
    writeUiLocale("zh-Hans");
    expect(vi.mocked(runAtomCommand)).toHaveBeenCalledWith(
      appAtomRegistry,
      serverEnvironment.updateSettings,
      {
        environmentId,
        input: { patch: { uiLocale: "zh-Hans" } },
      },
    );
  });
});
