import { describe, expect, it } from "vite-plus/test";

import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";

describe("normalizeDesktopUpdateReleaseNotes", () => {
  it("shows the newest changes and counts all real changes", () => {
    const result = normalizeDesktopUpdateReleaseNotes(
      [
        "- feat: first change",
        "- fix: second change",
        "- fix: third change",
        "- fix: fourth change",
        "- fix: fifth change",
        "- fix: sixth change",
        "- fix: seventh change",
        "- fix: eighth change",
        "- fix(web): keep long task drawers usable on small screens by @human in #8313",
        "- fix(opencode): handle child approvals, stops, and model catalogs by @human in #8480",
        "## New Contributors",
        "- @human made their first contribution in #8435",
        "**Full Changelog**: https://github.com/pingdotgg/t3code/compare/old...new",
      ].join("\n"),
      "0.0.36-nightly.20260828.1213",
    );

    expect(result).toEqual({
      releaseNotes: [
        {
          version: "0.0.36-nightly.20260828.1213",
          items: [
            "fix(opencode): handle child approvals, stops, and model catalogs by @human in #8480",
            "fix(web): keep long task drawers usable on small screens by @human in #8313",
            "fix: eighth change",
            "fix: seventh change",
            "fix: sixth change",
            "fix: fifth change",
            "fix: fourth change",
            "fix: third change",
          ],
          totalItems: 10,
        },
      ],
      omittedReleaseCount: 0,
    });
  });

  it("excludes a GitHub HTML contributor section", () => {
    const result = normalizeDesktopUpdateReleaseNotes(
      "<h2>What's Changed</h2><ul><li>Older fix</li><li>Newer fix</li></ul>" +
        "<h2>New Contributors</h2><ul><li>@human made their first contribution</li></ul>" +
        "<h2>Full Changelog</h2>",
      "1.2.3",
    );

    expect(result).toEqual({
      releaseNotes: [{ version: "1.2.3", items: ["Newer fix", "Older fix"], totalItems: 2 }],
      omittedReleaseCount: 0,
    });
  });

  it("does not count Markdown or HTML section headings as changes", () => {
    const changes = Array.from({ length: 8 }, (_, index) => `Change ${index + 1}`);
    const result = normalizeDesktopUpdateReleaseNotes(
      [
        { version: "1.2.4", note: ["### Features", ...changes].join("\n- ") },
        {
          version: "1.2.3",
          note: `<h3>Fixes</h3><ul>${changes.map((change) => `<li>${change}</li>`).join("")}</ul>`,
        },
      ],
      "1.2.4",
    );

    expect(result.releaseNotes).toEqual([
      { version: "1.2.4", items: changes.toReversed(), totalItems: 8 },
      { version: "1.2.3", items: changes.toReversed(), totalItems: 8 },
    ]);
  });

  it("keeps per-version order and drops empty groups", () => {
    const result = normalizeDesktopUpdateReleaseNotes(
      [
        { version: "1.2.3", note: "- Newer release" },
        { version: "1.2.2", note: "Full changelog: https://example.com/compare/x...y" },
        { version: "1.2.1", note: "- Older release" },
      ],
      "1.2.3",
    );

    expect(result).toEqual({
      releaseNotes: [
        { version: "1.2.3", items: ["Newer release"], totalItems: 1 },
        { version: "1.2.1", items: ["Older release"], totalItems: 1 },
      ],
      omittedReleaseCount: 0,
    });
  });

  it("counts valid groups before applying the six-release limit", () => {
    const releaseNotes = [
      { version: "1.3.9", note: "- Change 9" },
      { version: "1.3.8", note: "Full changelog: https://example.com/compare/x...y" },
      { version: "1.3.7", note: "- Change 7" },
      { version: "1.3.6", note: "- Change 6" },
      { version: "1.3.5", note: "- Change 5" },
      { version: "1.3.4", note: "- Change 4" },
      { version: "1.3.3", note: "- Change 3" },
      { version: "1.3.2", note: "- Change 2" },
    ];

    const result = normalizeDesktopUpdateReleaseNotes(releaseNotes, "1.3.9");

    expect(result.releaseNotes.map(({ version }) => version)).toEqual([
      "1.3.9",
      "1.3.7",
      "1.3.6",
      "1.3.5",
      "1.3.4",
      "1.3.3",
    ]);
    expect(result.omittedReleaseCount).toBe(1);
  });

  it("decodes valid HTML entities", () => {
    const result = normalizeDesktopUpdateReleaseNotes("- Fix &amp; polish &#128512;", "1.0.0");
    expect(result).toEqual({
      releaseNotes: [{ version: "1.0.0", items: ["Fix & polish 😀"], totalItems: 1 }],
      omittedReleaseCount: 0,
    });
  });

  it("ignores malformed and empty entries instead of throwing", () => {
    const result = normalizeDesktopUpdateReleaseNotes(
      [
        { version: "1.2.3", note: "- Valid change" },
        { version: "1.2.2", note: "" },
        { version: 42, note: "- Bad version type" },
        { version: "1.2.1", note: { html: "<p>object note</p>" } },
        "not an object",
        null,
      ],
      "1.2.3",
    );

    expect(result).toEqual({
      releaseNotes: [{ version: "1.2.3", items: ["Valid change"], totalItems: 1 }],
      omittedReleaseCount: 0,
    });
  });

  it("returns an empty result for an invalid payload", () => {
    expect(normalizeDesktopUpdateReleaseNotes({ note: "- Invalid" }, "1.0.0")).toEqual({
      releaseNotes: [],
      omittedReleaseCount: 0,
    });
  });

  it("does not throw on out-of-range numeric entities and keeps the literal", () => {
    const result = normalizeDesktopUpdateReleaseNotes("- Broken entity &#9999999999;", "1.0.0");
    expect(result).toEqual({
      releaseNotes: [{ version: "1.0.0", items: ["Broken entity &#9999999999;"], totalItems: 1 }],
      omittedReleaseCount: 0,
    });
  });
});
