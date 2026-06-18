import type { T3HostAppearance, T3HostBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { applyHostAppearanceToDocument, resolveHostResolvedTheme } from "./hostAppearance";

function createDocumentStub() {
  const classes = new Set<string>();
  const dataset: Record<string, string> = {};
  return {
    documentElement: {
      dataset,
      setAttribute: (name: string, value: string) => {
        if (name === "data-t3-host-theme") {
          dataset.t3HostTheme = value;
        }
      },
      removeAttribute: (name: string) => {
        if (name === "data-t3-host-theme") {
          delete dataset.t3HostTheme;
        }
      },
      classList: {
        contains: (className: string) => classes.has(className),
        toggle: (className: string, force?: boolean) => {
          const shouldAdd = force ?? !classes.has(className);
          if (shouldAdd) {
            classes.add(className);
          } else {
            classes.delete(className);
          }
          return shouldAdd;
        },
      },
    },
  };
}

describe("host appearance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves VS Code appearance as the host-driven app theme", () => {
    expect(resolveHostResolvedTheme({ themeSource: "vscode", colorScheme: "dark" })).toBe("dark");
    expect(resolveHostResolvedTheme({ themeSource: "vscode", colorScheme: "light" })).toBe("light");
    expect(resolveHostResolvedTheme({ themeSource: "default", colorScheme: "dark" })).toBe(null);
  });

  it("applies base VS Code theme propagation to the document", () => {
    const documentStub = createDocumentStub();
    vi.stubGlobal("document", documentStub);

    expect(applyHostAppearanceToDocument({ themeSource: "vscode", colorScheme: "dark" })).toBe(
      "dark",
    );

    expect(documentStub.documentElement.dataset.t3HostTheme).toBe("vscode");
    expect(documentStub.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes VS Code theme propagation when toggled back to the default app theme", () => {
    const documentStub = createDocumentStub();
    vi.stubGlobal("document", documentStub);

    applyHostAppearanceToDocument({ themeSource: "vscode", colorScheme: "dark" });
    expect(applyHostAppearanceToDocument({ themeSource: "default", colorScheme: "dark" })).toBe(
      null,
    );

    expect(documentStub.documentElement.dataset.t3HostTheme).toBeUndefined();
    expect(documentStub.documentElement.classList.contains("dark")).toBe(true);
  });

  it("applies and notifies subscribers when the host bridge changes appearance", async () => {
    vi.resetModules();
    const documentStub = createDocumentStub();
    vi.stubGlobal("document", documentStub);

    const defaultAppearance: T3HostAppearance = {
      themeSource: "default",
      colorScheme: "light",
    };
    const vscodeAppearance: T3HostAppearance = {
      themeSource: "vscode",
      colorScheme: "dark",
    };
    const firstBridge: T3HostBridge = {
      getLocalEnvironmentBootstrap: () => null,
      getHostAppearance: () => defaultAppearance,
    };
    const secondBridge: T3HostBridge = {
      getLocalEnvironmentBootstrap: () => null,
      getHostAppearance: () => vscodeAppearance,
    };
    vi.stubGlobal("window", { t3HostBridge: firstBridge });

    const module = await import("./hostAppearance");
    const subscriber = vi.fn();
    module.subscribeHostAppearance(subscriber);

    vi.stubGlobal("window", { t3HostBridge: secondBridge });
    expect(module.readHostAppearance()).toEqual(vscodeAppearance);

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(documentStub.documentElement.dataset.t3HostTheme).toBe("vscode");
    expect(documentStub.documentElement.classList.contains("dark")).toBe(true);
  });
});
