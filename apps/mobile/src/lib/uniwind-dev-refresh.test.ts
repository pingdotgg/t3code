import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeURL from "node:url";

vi.mock("react-native", () => ({
  Appearance: {
    addChangeListener: vi.fn(),
    getColorScheme: () => "light",
    setColorScheme: vi.fn(),
  },
  Platform: { constants: {}, OS: "ios" },
}));

vi.mock("../../node_modules/uniwind/src/core/listener", () => ({
  UniwindListener: { notify() {}, notifyAll() {} },
}));

vi.mock("../../node_modules/uniwind/src/core/native", () => ({
  UniwindStore: {
    reinit: (generateStyleSheetCallback: () => unknown) => {
      generateStyleSheetCallback();
    },
    runtime: { currentThemeName: "light", insets: {} },
    vars: {},
  },
}));

const loadUniwind = async () => {
  const modulePath = NodeURL.fileURLToPath(
    new URL("../../node_modules/uniwind/src/core/config/config.native.ts", import.meta.url),
  );
  const { Uniwind } = (await import(/* @vite-ignore */ modulePath)) as {
    Uniwind: { readonly themes: Array<string> };
  };
  return Uniwind as typeof Uniwind & {
    __reinit: (initialize: () => unknown, themes: Array<string>, fingerprint?: string) => void;
  };
};

describe("Uniwind native stylesheet refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("__DEV__", true);
  });

  it("initializes once for identical generated styles", async () => {
    const Uniwind = await loadUniwind();
    const initialize = vi.fn(() => ({}));

    Uniwind.__reinit(initialize, ["light", "dark"], "same-output");
    Uniwind.__reinit(initialize, ["light", "dark"], "same-output");

    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("reinitializes for changed generated styles and themes", async () => {
    const Uniwind = await loadUniwind();
    const initialize = vi.fn(() => ({}));

    Uniwind.__reinit(initialize, ["light", "dark"], "before");
    Uniwind.__reinit(initialize, ["light", "dark"], "after");
    Uniwind.__reinit(initialize, ["light", "dark", "dim"], "themes-with-dim");

    expect(initialize).toHaveBeenCalledTimes(3);
    expect(Uniwind.themes).toEqual(["light", "dark", "dim"]);
  });

  it("retries the same output after initialization fails", async () => {
    const Uniwind = await loadUniwind();
    const initialize = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("initialization failed");
      })
      .mockImplementationOnce(() => ({}));

    expect(() => Uniwind.__reinit(initialize, ["light", "dark"], "retry-output")).toThrow(
      "initialization failed",
    );
    Uniwind.__reinit(initialize, ["light", "dark"], "retry-output");

    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it("keeps no-fingerprint and production reinitialization semantics", async () => {
    const Uniwind = await loadUniwind();
    const initialize = vi.fn(() => ({}));

    Uniwind.__reinit(initialize, ["light", "dark"]);
    Uniwind.__reinit(initialize, ["light", "dark"]);
    vi.stubGlobal("__DEV__", false);
    Uniwind.__reinit(initialize, ["light", "dark"], "same-output");
    Uniwind.__reinit(initialize, ["light", "dark"], "same-output");

    expect(initialize).toHaveBeenCalledTimes(4);
  });
});
