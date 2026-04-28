import { describe, expect, it } from "vitest";
import { applyInterfaceSettingsToDocument, getCodeEditorFontSize } from "./interfaceAppearance";

function createDocumentStub() {
  const values = new Map<string, string>();
  const styleState = {
    setProperty(name: string, value: string) {
      values.set(name, value);
    },
    removeProperty(name: string) {
      values.delete(name);
    },
    getPropertyValue(name: string) {
      return values.get(name) ?? "";
    },
  };

  return {
    document: {
      documentElement: {
        dataset: {} as Record<string, string>,
        style: styleState,
      },
    } as unknown as Document,
    values,
  };
}

describe("interfaceAppearance", () => {
  it("applies UI and code font scale tokens to the document", () => {
    const { document, values } = createDocumentStub();

    applyInterfaceSettingsToDocument(
      {
        uiFontScale: 17,
        codeFontScale: 11,
      },
      document,
    );

    expect(document.documentElement.dataset.uiFontScale).toBe("17");
    expect(document.documentElement.dataset.codeFontScale).toBe("11");
    expect(values.get("--app-ui-root-font-size")).toBe("17px");
    expect(values.get("--app-ui-text-sm")).toBe("14.5px");
    expect(values.get("--app-code-font-size")).toBe("9px");
    expect(values.get("--app-code-font-size-compact")).toBe("8px");
  });

  it("applies and clears font smoothing styles", () => {
    const { document, values } = createDocumentStub();

    applyInterfaceSettingsToDocument(
      {
        macOsFontSmoothing: "grayscale",
      },
      document,
    );

    expect(document.documentElement.dataset.fontSmoothing).toBe("grayscale");
    expect(values.get("-webkit-font-smoothing")).toBe("antialiased");
    expect(values.get("-moz-osx-font-smoothing")).toBe("grayscale");

    applyInterfaceSettingsToDocument(
      {
        macOsFontSmoothing: "auto",
      },
      document,
    );

    expect(document.documentElement.dataset.fontSmoothing).toBe("auto");
    expect(values.has("-webkit-font-smoothing")).toBe(false);
    expect(values.has("-moz-osx-font-smoothing")).toBe(false);
  });

  it("returns the configured Monaco editor font sizes", () => {
    expect(getCodeEditorFontSize(11)).toBe(11);
    expect(getCodeEditorFontSize(14)).toBe(14);
    expect(getCodeEditorFontSize(19)).toBe(19);
  });
});
