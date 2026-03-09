import { describe, expect, it, vi } from "vitest";

import { buildEditableContextMenuTemplate } from "./editableContextMenu";

describe("buildEditableContextMenuTemplate", () => {
  const editFlags = {
    canCopy: true,
    canCut: true,
    canDelete: true,
    canEditRichly: false,
    canPaste: true,
    canRedo: false,
    canSelectAll: true,
    canUndo: true,
  };

  it("returns no menu items for non-editable targets", () => {
    const replaceMisspelling = vi.fn();
    const addWordToDictionary = vi.fn();

    const template = buildEditableContextMenuTemplate(
      {
        dictionarySuggestions: ["hello"],
        editFlags,
        isEditable: false,
        misspelledWord: "helo",
        x: 0,
        y: 0,
      },
      { replaceMisspelling, addWordToDictionary },
    );

    expect(template).toEqual([]);
  });

  it("prepends spelling suggestions and add-to-dictionary for misspellings", () => {
    const replaceMisspelling = vi.fn();
    const addWordToDictionary = vi.fn();

    const template = buildEditableContextMenuTemplate(
      {
        dictionarySuggestions: ["hello", "help"],
        editFlags,
        isEditable: true,
        misspelledWord: "helo",
        x: 12.8,
        y: 24.1,
      },
      { replaceMisspelling, addWordToDictionary },
    );

    expect(template.slice(0, 4)).toMatchObject([
      { label: "hello" },
      { label: "help" },
      { label: "Add to Dictionary" },
      { type: "separator" },
    ]);

    const suggestion = template[0];
    if (!suggestion || typeof suggestion.click !== "function") {
      throw new Error("Expected spelling suggestion action");
    }
    suggestion.click(undefined as never, undefined as never, undefined as never);

    const addWord = template[2];
    if (!addWord || typeof addWord.click !== "function") {
      throw new Error("Expected add-to-dictionary action");
    }
    addWord.click(undefined as never, undefined as never, undefined as never);

    expect(replaceMisspelling).toHaveBeenCalledWith("hello");
    expect(addWordToDictionary).toHaveBeenCalledWith("helo");
  });

  it("shows a disabled fallback label when there are no spelling suggestions", () => {
    const template = buildEditableContextMenuTemplate(
      {
        dictionarySuggestions: [],
        editFlags,
        isEditable: true,
        misspelledWord: "helo",
        x: 0,
        y: 0,
      },
      {
        replaceMisspelling: vi.fn(),
        addWordToDictionary: vi.fn(),
      },
    );

    expect(template[0]).toMatchObject({
      enabled: false,
      label: "No spelling suggestions",
    });
    expect(template[1]).toMatchObject({
      label: "Add to Dictionary",
    });
  });

  it("trims and deduplicates spelling suggestions before rendering them", () => {
    const template = buildEditableContextMenuTemplate(
      {
        dictionarySuggestions: [" hello ", "hello", "", "help", "help", "hero"],
        editFlags,
        isEditable: true,
        misspelledWord: " helo ",
        x: 0,
        y: 0,
      },
      {
        replaceMisspelling: vi.fn(),
        addWordToDictionary: vi.fn(),
      },
    );

    expect(template.slice(0, 4)).toMatchObject([
      { label: "hello" },
      { label: "help" },
      { label: "hero" },
      { label: "Add to Dictionary" },
    ]);
  });

  it("includes standard edit actions even without a misspelling", () => {
    const template = buildEditableContextMenuTemplate(
      {
        dictionarySuggestions: ["hello"],
        editFlags,
        isEditable: true,
        misspelledWord: "",
        x: 0,
        y: 0,
      },
      {
        replaceMisspelling: vi.fn(),
        addWordToDictionary: vi.fn(),
      },
    );

    expect(template).toMatchObject([
      { enabled: true, role: "undo" },
      { enabled: false, role: "redo" },
      { type: "separator" },
      { enabled: true, role: "cut" },
      { enabled: true, role: "copy" },
      { enabled: true, role: "paste" },
      { enabled: true, role: "delete" },
      { type: "separator" },
      { enabled: true, role: "selectAll" },
    ]);
  });
});
