import { DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand } from "./keybindings";

import {
  insertPinnedSelection,
  MAX_PINNED_SELECTIONS,
  pinnedSelectionPreview,
  pinnedSelectionsFromPersisted,
  settledPinsToastTitle,
  type PinnedSelection,
  type PinnedSelectionDraft,
} from "./pinnedSelections";

const draft: PinnedSelectionDraft = {
  messageId: "message-1",
  text: "alpha beta gamma delta epsilon zeta eta",
  start: 0,
  end: 6,
  prefix: "",
  suffix: " beta",
};

function pin(id: string, overrides: Partial<PinnedSelectionDraft> = {}): PinnedSelection {
  return {
    id,
    createdAt: "2026-04-01T00:00:00.000Z",
    ...draft,
    ...overrides,
  };
}

describe("pinned selections", () => {
  it("previews the first few words", () => {
    expect(pinnedSelectionPreview("  alpha   beta gamma delta epsilon zeta eta  ")).toBe(
      "alpha beta gamma delta epsilon zeta…",
    );
    expect(pinnedSelectionPreview("short pin")).toBe("short pin");
  });

  it("dedupes the same span and caps the list", () => {
    const first = insertPinnedSelection([], draft, "pin-1", "2026-04-01T00:00:00.000Z");
    const again = insertPinnedSelection(
      first.selections,
      draft,
      "pin-2",
      "2026-04-02T00:00:00.000Z",
    );
    expect(again.pin.id).toBe("pin-1");
    expect(again.selections).toBe(first.selections);

    const many = Array.from({ length: MAX_PINNED_SELECTIONS }, (_, index) =>
      pin(`pin-${index}`, { text: `word ${index}`, start: index, end: index + 1 }),
    );
    const added = insertPinnedSelection(
      many,
      { ...draft, text: "newest pin", start: 90, end: 96 },
      "pin-new",
      "2026-04-03T00:00:00.000Z",
    );
    expect(added.selections).toHaveLength(MAX_PINNED_SELECTIONS);
    expect(added.selections[0]?.id).toBe("pin-1");
    expect(added.selections.at(-1)?.id).toBe("pin-new");
  });

  it("drops malformed pins and unknown versions", () => {
    expect(
      pinnedSelectionsFromPersisted(1, {
        "env:thread": [pin("pin-1"), { id: "", messageId: "m", text: "x", start: 0, end: 1 }],
      }),
    ).toEqual({ "env:thread": [pin("pin-1")] });
    expect(pinnedSelectionsFromPersisted(2, { "env:thread": [pin("pin-1")] })).toEqual({});
    expect(pinnedSelectionsFromPersisted(undefined, undefined)).toEqual({});
  });

  it("describes leftover pins when a thread settles", () => {
    expect(settledPinsToastTitle(0)).toBeNull();
    expect(settledPinsToastTitle(1)).toBe("This thread still has a pin");
    expect(settledPinsToastTitle(3)).toBe("This thread still has 3 pins");
  });

  it("uses Cmd+P for a text selection and leaves the file picker otherwise", () => {
    expect(DEFAULT_KEYBINDINGS.find((binding) => binding.command === "thread.pin")?.key).toBe(
      "mod+shift+p",
    );
    expect(
      DEFAULT_KEYBINDINGS.find((binding) => binding.command === "filePicker.toggle")?.key,
    ).toBe("mod+p");
    expect(
      DEFAULT_KEYBINDINGS.find((binding) => binding.command === "thread.pinSelection")?.key,
    ).toBe("mod+p");
    const event = { key: "p", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
    expect(
      resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { textSelected: true },
      }),
    ).toBe("thread.pinSelection");
    expect(
      resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
    ).toBe("filePicker.toggle");
  });
});
