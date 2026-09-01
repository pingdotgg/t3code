import { describe, expect, it } from "vite-plus/test";

import {
  droppedPathsResolveInEnvironment,
  formatDroppedFilePaths,
  quoteDroppedFilePath,
} from "./droppedFilePaths";

describe("quoteDroppedFilePath", () => {
  it("leaves a path without whitespace alone", () => {
    expect(quoteDroppedFilePath("/Users/me/notes.pdf")).toBe("/Users/me/notes.pdf");
  });

  it("escapes a double quote inside a quoted path", () => {
    expect(quoteDroppedFilePath('/tmp/a " b.pdf')).toBe('"/tmp/a \\" b.pdf"');
  });

  it("leaves a double quote alone when there is no whitespace to quote for", () => {
    expect(quoteDroppedFilePath('/tmp/a"b.pdf')).toBe('/tmp/a"b.pdf');
  });

  it("quotes a path containing spaces", () => {
    expect(quoteDroppedFilePath("/Users/me/Voice Memos/note 1.m4a")).toBe(
      '"/Users/me/Voice Memos/note 1.m4a"',
    );
  });
});

describe("formatDroppedFilePaths", () => {
  it("joins several paths with a space", () => {
    expect(formatDroppedFilePaths(["/a/one.opus", "/b/two.pdf"])).toBe("/a/one.opus /b/two.pdf");
  });

  it("preserves a trailing space in a filename instead of trimming it", () => {
    expect(formatDroppedFilePaths(["/tmp/report "])).toBe('"/tmp/report "');
  });

  it("skips empty and whitespace-only entries", () => {
    expect(formatDroppedFilePaths(["", "   ", "/a/one.opus"])).toBe("/a/one.opus");
  });

  it("returns an empty string when nothing resolved", () => {
    expect(formatDroppedFilePaths([])).toBe("");
  });
});

describe("droppedPathsResolveInEnvironment", () => {
  const LOCAL = "env-local";
  const OTHER = "env-other";

  it("accepts a thread running on the desktop-managed environment", () => {
    expect(
      droppedPathsResolveInEnvironment({
        primarySource: "desktop-managed",
        primaryEnvironmentId: LOCAL,
        threadEnvironmentId: LOCAL,
      }),
    ).toBe(true);
  });

  it("refuses a thread on a different environment even when the bridge is present", () => {
    // The desktop app supervises env-local, but this thread runs on another
    // machine: its agent cannot open a path read from this filesystem.
    expect(
      droppedPathsResolveInEnvironment({
        primarySource: "desktop-managed",
        primaryEnvironmentId: LOCAL,
        threadEnvironmentId: OTHER,
      }),
    ).toBe(false);
  });

  it.each(["configured", "manual", "window-origin"])(
    "refuses a %s connection, which always names a server elsewhere",
    (source) => {
      expect(
        droppedPathsResolveInEnvironment({
          primarySource: source,
          primaryEnvironmentId: LOCAL,
          threadEnvironmentId: LOCAL,
        }),
      ).toBe(false);
    },
  );

  it("refuses while either id is still unknown", () => {
    // Bootstrapping is not evidence the thread runs here; guessing wrong
    // inserts a path the agent silently cannot read.
    expect(
      droppedPathsResolveInEnvironment({
        primarySource: "desktop-managed",
        primaryEnvironmentId: undefined,
        threadEnvironmentId: LOCAL,
      }),
    ).toBe(false);
    expect(
      droppedPathsResolveInEnvironment({
        primarySource: "desktop-managed",
        primaryEnvironmentId: LOCAL,
        threadEnvironmentId: undefined,
      }),
    ).toBe(false);
  });

  it("refuses when there is no primary environment at all", () => {
    expect(
      droppedPathsResolveInEnvironment({
        primarySource: undefined,
        primaryEnvironmentId: undefined,
        threadEnvironmentId: LOCAL,
      }),
    ).toBe(false);
  });
});
