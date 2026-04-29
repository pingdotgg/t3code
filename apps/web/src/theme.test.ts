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

  it("resolves system mode from the OS family", () => {
    expect(resolveThemeMode({ mode: "system", hue: 222, saturation: 68 }, false)).toBe("light");
    expect(resolveThemeMode({ mode: "system", hue: 222, saturation: 68 }, true)).toBe("dark");
  });

  it("maps explicit modes directly", () => {
    expect(resolveThemeMode({ mode: "light", hue: 222, saturation: 68 })).toBe("light");
    expect(resolveThemeMode({ mode: "dark", hue: 222, saturation: 68 })).toBe("dark");
  });

  it("resolves desktop theme from explicit and system modes", () => {
    expect(resolveDesktopTheme({ mode: "system", hue: 222, saturation: 68 }, true)).toBe("system");
    expect(resolveDesktopTheme({ mode: "light", hue: 222, saturation: 68 })).toBe("light");
    expect(resolveDesktopTheme({ mode: "dark", hue: 222, saturation: 68 })).toBe("dark");
  });

  it("generates stable tokens and palette data", () => {
    const generated = generateTheme({ mode: "dark", hue: 280, saturation: 72 });

    expect(generated.resolvedMode).toBe("dark");
    expect(generated.monacoTheme).toBe("vs-dark");
    expect(generated.cssVariables["--primary"]).toContain("hsl(");
    expect(generated.terminalPalette.cursor).toContain("rgb(");
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
