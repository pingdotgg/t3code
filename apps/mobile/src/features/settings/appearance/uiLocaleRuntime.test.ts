import { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { watchUiLocale } from "./uiLocaleRuntime";

const environmentId = EnvironmentId.make("env-1");

function configWith(settings: Record<string, unknown>) {
  return { settings } as unknown as ServerConfig;
}

describe("watchUiLocale", () => {
  it("feeds the resolved locale from pushed server settings to changeLanguage", () => {
    const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
      new Map([[environmentId, configWith({})]]),
    );
    const registry = AtomRegistry.make();
    const changeLanguage = vi.fn().mockResolvedValue(undefined);

    const unsubscribe = watchUiLocale({
      registry,
      configsAtom: configs,
      systemLocale: "en-US",
      changeLanguage,
    });
    expect(changeLanguage).toHaveBeenCalledWith("en");

    registry.set(configs, new Map([[environmentId, configWith({ uiLocale: "zh-Hans" })]]));
    expect(changeLanguage).toHaveBeenCalledWith("zh-Hans");

    // Back to no explicit setting: falls through to the system language.
    registry.set(configs, new Map([[environmentId, configWith({})]]));
    expect(changeLanguage).toHaveBeenCalledWith("en");

    unsubscribe();
  });

  it("follows the system language only when no server sets a locale", () => {
    const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(new Map());
    const registry = AtomRegistry.make();
    const changeLanguage = vi.fn().mockResolvedValue(undefined);

    const unsubscribe = watchUiLocale({
      registry,
      configsAtom: configs,
      systemLocale: "zh-CN",
      changeLanguage,
    });
    expect(changeLanguage).toHaveBeenCalledWith("zh-Hans");

    registry.set(configs, new Map([[environmentId, configWith({ uiLocale: "en" })]]));
    expect(changeLanguage).toHaveBeenCalledWith("en");

    unsubscribe();
  });
});
