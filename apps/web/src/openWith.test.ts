import { describe, expect, it } from "vite-plus/test";
import {
  OpenWithEntryId,
  type OpenWithEntry,
  type OpenWithEntryPresentation,
} from "@t3tools/contracts";

import { mergeOpenWithOptions, nextOpenWithEntryId, resolveEffectiveOpenWith } from "./openWith";

const customEntry: OpenWithEntry = {
  id: OpenWithEntryId.make("terminal"),
  name: "Terminal",
  kind: "terminal",
  invocation: { type: "command", executable: "terminal" },
  directoryMode: "open-target",
  arguments: [],
};

const presentation = (available: boolean): OpenWithEntryPresentation => ({
  entryId: customEntry.id,
  available,
  iconDataUrl: null,
  ...(available ? {} : { unavailableReason: "Missing" }),
});

describe("Open With preference logic", () => {
  it("merges custom entries only when explicitly enabled", () => {
    expect(
      mergeOpenWithOptions({
        availableEditors: ["vscode"],
        customEntries: [customEntry],
        presentations: [presentation(true)],
        includeCustomEntries: false,
      }),
    ).toEqual([{ type: "builtin", id: "vscode" }]);
    expect(
      mergeOpenWithOptions({
        availableEditors: ["vscode"],
        customEntries: [customEntry],
        presentations: [presentation(true)],
        includeCustomEntries: true,
      }),
    ).toHaveLength(2);
  });

  it("resolves an available custom preference", () => {
    const options = mergeOpenWithOptions({
      availableEditors: ["vscode"],
      customEntries: [customEntry],
      presentations: [presentation(true)],
      includeCustomEntries: true,
    });
    expect(
      resolveEffectiveOpenWith({
        options,
        preferred: { type: "custom", id: customEntry.id },
        legacyPreferredEditor: null,
      }),
    ).toMatchObject({ type: "custom", entry: customEntry });
  });

  it("falls back without overwriting an unavailable saved preference", () => {
    const options = mergeOpenWithOptions({
      availableEditors: ["vscode", "cursor"],
      customEntries: [customEntry],
      presentations: [presentation(false)],
      includeCustomEntries: true,
    });
    expect(
      resolveEffectiveOpenWith({
        options,
        preferred: { type: "custom", id: customEntry.id },
        legacyPreferredEditor: "vscode",
      }),
    ).toEqual({ type: "builtin", id: "cursor" });
  });

  it("uses the legacy editor only when no combined preference is saved", () => {
    const options = mergeOpenWithOptions({
      availableEditors: ["vscode", "cursor"],
      customEntries: [],
      presentations: [],
      includeCustomEntries: false,
    });
    expect(
      resolveEffectiveOpenWith({
        options,
        preferred: null,
        legacyPreferredEditor: "cursor",
      }),
    ).toEqual({ type: "builtin", id: "cursor" });
  });

  it("uses normalized slugs and numeric collision suffixes", () => {
    expect(nextOpenWithEntryId("Terminal App", [])).toBe("terminal-app");
    expect(nextOpenWithEntryId("Terminal App", ["terminal-app"])).toBe("terminal-app-2");
  });
});
