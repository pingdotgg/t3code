import {
  ComposerContextId,
  EnvironmentId,
  type ComposerContextRecord,
  type LocationContextRecord,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { parseSharedLocations } from "@t3tools/shared/sharedLocation";
import { describe, expect, it } from "vite-plus/test";

import {
  expandLocationContextReferences,
  importPastedComposerText,
} from "./composerInlineTokenPaste";

const sharedLocation: LocationContextRecord = {
  version: 1,
  kind: "location",
  contextId: ComposerContextId.make("location_1"),
  label: "Office",
  payload: {
    name: "Office",
    address: "100 Main Street",
    latitude: 40.7128,
    longitude: -74.006,
    accuracy: 8,
  },
};

function clipboardData(text: string, records: ReadonlyArray<ComposerContextRecord>) {
  const fragment = encodeComposerContextFragment({
    version: 1,
    source: { environmentId: EnvironmentId.make("source") },
    records,
  });
  return {
    getData(type: string) {
      if (type === "text/plain") return text;
      if (type === COMPOSER_CONTEXT_CLIPBOARD_MIME) return fragment ?? "";
      return "";
    },
  };
}

describe("composerInlineTokenPaste", () => {
  it("expands each referenced location once and leaves repeated mentions as text", () => {
    const text =
      "Meet at [Office](t3-context://v1/location/location_1), then return to [there](t3-context://v1/location/location_1).";

    const imported = importPastedComposerText(clipboardData(text, [sharedLocation]));
    const parsed = parseSharedLocations(imported);

    expect(parsed.locations).toHaveLength(1);
    expect(parsed.locations[0]).toMatchObject({
      name: "Office",
      address: "100 Main Street",
      latitude: 40.7128,
      longitude: -74.006,
      accuracy: 8,
    });
    expect(imported).toContain("then return to there.");
    expect(collectComposerContextReferences(imported)).toEqual([]);
  });

  it("keeps unknown or ambiguous location references instead of selecting arbitrary data", () => {
    const missing = "[Elsewhere](t3-context://v1/location/missing)";
    const ambiguous = "[Office](t3-context://v1/location/location_1)";
    const otherLocation = {
      ...sharedLocation,
      payload: { ...sharedLocation.payload, name: "Other office" },
    };

    expect(expandLocationContextReferences(missing, [sharedLocation])).toBe(missing);
    expect(expandLocationContextReferences(ambiguous, [sharedLocation, otherLocation])).toBe(
      ambiguous,
    );
  });

  it("passes other clipboard records through the existing importer", () => {
    const terminal: ComposerContextRecord = {
      version: 1,
      kind: "terminal",
      contextId: ComposerContextId.make("terminal_1"),
      label: "Terminal output",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 1,
      lineEnd: 1,
      text: "Ready",
    };
    const text = [
      "[Office](t3-context://v1/location/location_1)",
      "[Terminal output](t3-context://v1/terminal/terminal_1)",
    ].join("\n");
    let importedKinds: ReadonlyArray<string> = [];

    const imported = importPastedComposerText(
      clipboardData(text, [sharedLocation, terminal]),
      (fragment) => {
        importedKinds = fragment.records.map((record) => record.kind);
        return new Map([["terminal_1", "terminal_imported"]]);
      },
    );

    expect(importedKinds).toEqual(["terminal"]);
    expect(imported).toContain("t3-context://v1/terminal/terminal_imported");
    expect(parseSharedLocations(imported).locations).toHaveLength(1);
  });
});
