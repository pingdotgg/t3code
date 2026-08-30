import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const persistenceMocks = vi.hoisted(() => ({
  persistedSettings: null as typeof DEFAULT_CLIENT_SETTINGS | null,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => persistenceMocks.persistedSettings,
      setClientSettings: async () => undefined,
    },
  }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  ensureClientSettingsHydrated,
  getClientSettings,
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
  useShowFileLinkPaths,
} from "./useSettings";

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

afterEach(() => {
  persistenceMocks.persistedSettings = null;
  __resetClientSettingsPersistenceForTests();
  vi.unstubAllGlobals();
});

describe("useShowFileLinkPaths", () => {
  it("hydrates the persisted preference and updates the selected value", async () => {
    persistenceMocks.persistedSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      showFileLinkPaths: true,
    };
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.createElement("div") as unknown as Element);
    const observed: boolean[] = [];

    function Probe() {
      observed.push(useShowFileLinkPaths());
      return null;
    }

    try {
      flushSync(() => root.render(createElement(Probe)));
      expect(observed.at(-1)).toBe(false);

      await ensureClientSettingsHydrated();
      flushSync(() => undefined);
      expect(observed.at(-1)).toBe(true);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("ignores unrelated setting writes but rerenders for a real toggle", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.createElement("div") as unknown as Element);
    const renderCount = vi.fn();

    function Probe() {
      renderCount();
      useShowFileLinkPaths();
      return null;
    }

    try {
      flushSync(() => root.render(createElement(Probe)));
      await ensureClientSettingsHydrated();
      flushSync(() => undefined);
      const settledRenderCount = renderCount.mock.calls.length;

      flushSync(() =>
        __setClientSettingsForTests({
          ...getClientSettings(),
          legacySidebarEnabled: !getClientSettings().legacySidebarEnabled,
        }),
      );
      expect(renderCount).toHaveBeenCalledTimes(settledRenderCount);

      flushSync(() =>
        __setClientSettingsForTests({
          ...getClientSettings(),
          showFileLinkPaths: true,
        }),
      );
      expect(renderCount).toHaveBeenCalledTimes(settledRenderCount + 1);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });
});
