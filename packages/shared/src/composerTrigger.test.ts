import { describe, expect, it } from "vite-plus/test";

import {
  continueComposerPathTrigger as continuePathTrigger,
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("continueComposerPathTrigger", () => {
  const prefix = "Inspect ";
  const previousText = prefix + "@Foreign";
  const previous = detectComposerTrigger(previousText, previousText.length);
  const continueComposerPathTrigger = (
    text: string,
    cursor: number,
    trigger = previous,
    source = previousText,
  ) => continuePathTrigger(text, cursor, trigger, source);

  it("retains the full query and replacement range in the middle of a prompt", () => {
    const query = "Foreign Subsidiaries Motion Video/Script Notes.md";
    const text = prefix + "@" + query + " then summarize";
    const cursor = prefix.length + 1 + query.length;
    const trigger = continueComposerPathTrigger(
      text,
      cursor,
      previous,
      previousText + " then summarize",
    );
    expect(trigger).toEqual({ kind: "path", query, rangeStart: prefix.length, rangeEnd: cursor });
    expect(
      replaceTextRange(
        text,
        trigger!.rangeStart,
        trigger!.rangeEnd,
        serializeComposerFileLink(query),
      ).text,
    ).toBe(
      prefix +
        "[Script Notes.md](Foreign%20Subsidiaries%20Motion%20Video/Script%20Notes.md) then summarize",
    );
  });

  it("rejects caret jumps into unchanged prose, even during an edit", () => {
    const suffix = " then summarize";
    const source = previousText + suffix;
    expect(continueComposerPathTrigger(source, source.length, previous, source)).toBeNull();
    const edited = previousText + " Subsidiaries" + suffix;
    expect(continueComposerPathTrigger(edited, edited.length, previous, source)).toBeNull();
    expect(
      continueComposerPathTrigger(previousText + " changed prose", 17, previous, source),
    ).toBeNull();
  });

  it("allows edits within the query and caret movement within its range", () => {
    const source = prefix + "@Foreign Subsidiaries then summarize";
    const end = (prefix + "@Foreign Subsidiaries").length;
    const active = {
      kind: "path" as const,
      query: "Foreign Subsidiaries",
      rangeStart: prefix.length,
      rangeEnd: end,
    };
    const edited = source.replace("Foreign", "Foreign New");
    expect(continueComposerPathTrigger(edited, end + 4, active, source)?.query).toBe(
      "Foreign New Subsidiaries",
    );
    expect(continueComposerPathTrigger(source, end - 3, active, source)?.query).toBe(
      "Foreign Subsidiar",
    );
  });

  it("keeps a trailing space and supports deleting back through it", () => {
    const text = prefix + "@Foreign ";
    expect(continueComposerPathTrigger(text, text.length, previous)?.query).toBe("Foreign ");
    expect(continueComposerPathTrigger(text, text.length - 1, previous)?.query).toBe("Foreign");
  });

  it.each(["\n", "\r", "\t", "\uFFFC"])("stops at the %j boundary", (boundary) => {
    const text = prefix + "@Foreign" + boundary + "Subsidiaries";
    expect(continueComposerPathTrigger(text, text.length, previous)).toBeNull();
  });

  it("does not continue after removing @, moving before it, or accepting a result", () => {
    expect(continueComposerPathTrigger(prefix + "Foreign ", 16, previous)).toBeNull();
    expect(continueComposerPathTrigger(prefix + "@Foreign ", prefix.length, previous)).toBeNull();
    const selected = prefix + "[Foreign Subsidiaries](Foreign%20Subsidiaries) ";
    expect(continueComposerPathTrigger(selected, selected.length, previous)).toBeNull();
  });

  it("does not discover old @ text when no path search was open", () => {
    expect(continueComposerPathTrigger("@Foreign Subsidiaries", 21, null)).toBeNull();
    const skill = detectComposerTrigger("$review", 7);
    expect(continueComposerPathTrigger("$review file", 12, skill)).toBeNull();
  });
});

describe("detectComposerTrigger", () => {
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});
