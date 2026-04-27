import { describe, expect, it, vi } from "vitest";
import {
  applyThemePreferenceToDocument,
  getThemeMetadata,
  readStoredThemePreference,
  resolveDesktopTheme,
  resolveThemeMode,
  resolveThemePreset,
} from "./theme";

function createDocumentStub() {
  const appendedElements: Array<{
    name?: string;
    attributes: Record<string, string>;
    setAttribute: (name: string, value: string) => void;
  }> = [];

  return {
    appendedElements,
    document: {
      documentElement: {
        classList: {
          toggle: vi.fn(),
          contains: vi.fn(() => false),
        },
        dataset: {} as Record<string, string>,
        style: {
          backgroundColor: "",
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
  it("migrates legacy stored dark to noir", () => {
    const storage = {
      getItem: vi.fn(() => "dark"),
      setItem: vi.fn(),
    };

    expect(readStoredThemePreference(storage)).toBe("noir");
    expect(storage.setItem).toHaveBeenCalledWith("forma:theme", "noir");
  });

  it("falls back to system for unknown stored values", () => {
    const storage = {
      getItem: vi.fn(() => "sepia"),
      setItem: vi.fn(),
    };

    expect(readStoredThemePreference(storage)).toBe("system");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("resolves system to light or noir from the OS family", () => {
    expect(resolveThemePreset("system", false)).toBe("light");
    expect(resolveThemePreset("system", true)).toBe("noir");
  });

  it("maps presets to light and dark families", () => {
    expect(resolveThemeMode("light")).toBe("light");
    expect(resolveThemeMode("dawn")).toBe("light");
    expect(resolveThemeMode("dusk")).toBe("light");
    expect(resolveThemeMode("noir")).toBe("dark");
    expect(resolveThemeMode("midnight")).toBe("dark");
    expect(resolveThemeMode("stone")).toBe("dark");
  });

  it("maps concrete presets back to desktop-supported themes", () => {
    expect(resolveDesktopTheme("system")).toBe("system");
    expect(resolveDesktopTheme("light")).toBe("light");
    expect(resolveDesktopTheme("dawn")).toBe("light");
    expect(resolveDesktopTheme("dusk")).toBe("light");
    expect(resolveDesktopTheme("noir")).toBe("dark");
    expect(resolveDesktopTheme("midnight")).toBe("dark");
    expect(resolveDesktopTheme("stone")).toBe("dark");
  });

  it("applies the resolved preset, dark class, and chrome color to the document", () => {
    const { document, appendedElements } = createDocumentStub();

    const resolvedPreset = applyThemePreferenceToDocument("stone", {
      document: document as never,
    });

    expect(resolvedPreset).toBe("stone");
    expect(document.documentElement.classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(document.documentElement.dataset.theme).toBe("stone");
    expect(document.documentElement.dataset.themePreference).toBe("stone");
    expect(document.documentElement.style.backgroundColor).toBe(
      getThemeMetadata("stone").chromeColor,
    );
    expect(document.body.style.backgroundColor).toBe(getThemeMetadata("stone").chromeColor);
    expect(appendedElements).toHaveLength(1);
    expect(appendedElements[0]?.attributes.content).toBe(getThemeMetadata("stone").chromeColor);
  });
});
