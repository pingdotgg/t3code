import { describe, expect, it, vi } from "vitest";
import {
  applyThemePreferenceToDocument,
  DEFAULT_CUSTOM_THEME_SETTINGS,
  generateTheme,
  readStoredThemeSettings,
  resolveDesktopTheme,
  resolveThemeMode,
} from "./theme";

function createDocumentStub() {
  const appendedElements: Array<{
    name?: string;
    attributes: Record<string, string>;
    setAttribute: (name: string, value: string) => void;
  }> = [];
  const styleValues = new Map<string, string>();

  return {
    appendedElements,
    styleValues,
    document: {
      documentElement: {
        classList: {
          toggle: vi.fn(),
          contains: vi.fn(() => false),
        },
        dataset: {} as Record<string, string>,
        style: {
          backgroundColor: "",
          setProperty(name: string, value: string) {
            styleValues.set(name, value);
          },
        },
      },
      body: {
        style: {
          backgroundColor: "",
        },
      },
      head: {
        append: (element: (typeof appendedElements)[number]) => {
          appendedElements.push(element);
        },
      },
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => {
        const attributes: Record<string, string> = {};
        return {
          attributes,
          name: "",
          setAttribute(name: string, value: string) {
            attributes[name] = value;
          },
        };
      }),
    },
  };
}

describe("theme", () => {
  it("preserves legacy system storage", () => {
    const storage = {
      getItem: vi.fn(() => "system"),
      setItem: vi.fn(),
    };

    expect(readStoredThemeSettings(storage)).toEqual(DEFAULT_CUSTOM_THEME_SETTINGS);
  });

  it("falls back to the new default for legacy preset strings", () => {
    const storage = {
      getItem: vi.fn(() => "stone"),
      setItem: vi.fn(),
    };

    expect(readStoredThemeSettings(storage)).toEqual(DEFAULT_CUSTOM_THEME_SETTINGS);
  });

  it("preserves explicit zero saturation from storage", () => {
    const storage = {
      getItem: vi.fn(() =>
        JSON.stringify({
          version: 2,
          mode: "dark",
          hue: 222,
          saturation: 0,
        }),
      ),
      setItem: vi.fn(),
    };

    expect(readStoredThemeSettings(storage)).toEqual({
      mode: "dark",
      hue: 222,
      saturation: 0,
    });
  });

  it("resolves system mode from the OS family", () => {
    expect(resolveThemeMode({ mode: "system", hue: 222, saturation: 68 }, false)).toBe("light");
    expect(resolveThemeMode({ mode: "system", hue: 222, saturation: 68 }, true)).toBe("dark");
  });

  it("maps explicit modes directly", () => {
    expect(resolveThemeMode({ mode: "light", hue: 222, saturation: 68 })).toBe("light");
    expect(resolveThemeMode({ mode: "dark", hue: 222, saturation: 68 })).toBe("dark");
    expect(resolveThemeMode({ mode: "highContrast", hue: 222, saturation: 68 })).toBe("dark");
  });

  it("resolves desktop theme from explicit and system modes", () => {
    expect(resolveDesktopTheme({ mode: "system", hue: 222, saturation: 68 }, true)).toBe("system");
    expect(resolveDesktopTheme({ mode: "light", hue: 222, saturation: 68 })).toBe("light");
    expect(resolveDesktopTheme({ mode: "dark", hue: 222, saturation: 68 })).toBe("dark");
    expect(resolveDesktopTheme({ mode: "highContrast", hue: 222, saturation: 68 })).toBe("dark");
  });

  it("generates stable tokens and palette data", () => {
    const generated = generateTheme({ mode: "dark", hue: 280, saturation: 72 });

    expect(generated.resolvedMode).toBe("dark");
    expect(generated.monacoTheme).toBe("vs-dark");
    expect(generated.cssVariables["--primary"]).toContain("hsl(");
    expect(generated.terminalPalette.cursor).toContain("rgb(");
  });

  it("makes high contrast darker with brighter dark-mode borders", () => {
    const dark = generateTheme({ mode: "dark", hue: 222, saturation: 68 });
    const highContrast = generateTheme({ mode: "highContrast", hue: 222, saturation: 68 });

    expect(highContrast.resolvedMode).toBe("dark");
    expect(highContrast.desktopTheme).toBe("dark");
    expect(highContrast.cssVariables["--background"]).toBe("hsl(222 10% 5%)");
    expect(highContrast.cssVariables["--border"]).toBe("hsl(222 18% 36%)");
    expect(highContrast.cssVariables["--border"]).not.toBe(dark.cssVariables["--border"]);
    expect(highContrast.cssVariables["--background"]).not.toBe(dark.cssVariables["--background"]);
  });

  it("lets saturation fully neutralize dark surfaces and borders", () => {
    const noir = generateTheme({ mode: "dark", hue: 222, saturation: 0 });

    expect(noir.cssVariables["--background"]).toBe("hsl(222 0% 8%)");
    expect(noir.cssVariables["--card"]).toBe("hsl(222 0% 11%)");
    expect(noir.cssVariables["--border"]).toBe("hsl(222 0% 22%)");
    expect(noir.cssVariables["--foreground"]).toBe("hsl(222 0% 93%)");
  });

  it("changes border chroma when saturation changes", () => {
    const lowSaturation = generateTheme({ mode: "dark", hue: 222, saturation: 10 });
    const highSaturation = generateTheme({ mode: "dark", hue: 222, saturation: 90 });

    expect(lowSaturation.cssVariables["--border"]).toBe("hsl(222 2% 22%)");
    expect(highSaturation.cssVariables["--border"]).toBe("hsl(222 14% 22%)");
    expect(lowSaturation.cssVariables["--border"]).not.toBe(
      highSaturation.cssVariables["--border"],
    );
  });

  it("applies generated settings and css vars to the document", () => {
    const { appendedElements, document, styleValues } = createDocumentStub();

    const generated = applyThemePreferenceToDocument(
      { mode: "dark", hue: 280, saturation: 72 },
      {
        document: document as never,
      },
    );

    expect(generated.resolvedMode).toBe("dark");
    expect(document.documentElement.classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(document.documentElement.dataset.theme).toBe("generated");
    expect(document.documentElement.dataset.themeMode).toBe("dark");
    expect(document.documentElement.dataset.themePreferenceMode).toBe("dark");
    expect(document.documentElement.dataset.themeHue).toBe("280");
    expect(document.documentElement.dataset.themeSaturation).toBe("72");
    expect(document.documentElement.style.backgroundColor).toBe(generated.chromeColor);
    expect(document.body.style.backgroundColor).toBe(generated.chromeColor);
    expect(styleValues.get("--primary")).toBe(generated.cssVariables["--primary"]);
    expect(appendedElements[0]?.attributes.content).toBe(generated.chromeColor);
  });
});
