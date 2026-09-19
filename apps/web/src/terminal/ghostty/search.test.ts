import { describe, expect, it } from "vite-plus/test";
import {
  closestTerminalSearchIndex,
  findTerminalSearchMatches,
  initialTerminalSearchIndex,
  MAX_TERMINAL_SEARCH_MATCHES,
  stepTerminalSearchIndex,
  terminalSearchHighlights,
  terminalSearchScrollDelta,
  type TerminalSearchCellRow,
  type TerminalSearchMatch,
  type TerminalSearchRows,
} from "./search";

const insensitiveLiteral = { caseSensitive: false };

function match(row: number, start: number, end: number): TerminalSearchMatch {
  return { start: { row, offset: start }, end: { row, offset: end } };
}

describe("findTerminalSearchMatches", () => {
  it("finds case-insensitive matches", () => {
    const rows = { texts: ["Hello", "HELLO"], wraps: [false, false] };
    expect(findTerminalSearchMatches(rows, "hello", insensitiveLiteral)).toEqual({
      matches: [match(0, 0, 5), match(1, 0, 5)],
      truncated: false,
    });
  });

  it("respects case-sensitive option", () => {
    const rows = { texts: ["Hello HELLO hello"], wraps: [false] };
    expect(findTerminalSearchMatches(rows, "hello", { caseSensitive: true })).toEqual({
      matches: [match(0, 12, 17)],
      truncated: false,
    });
  });

  it("matches regex metacharacters literally", () => {
    const rows = { texts: ["xa+(by", "x"], wraps: [false, false] };
    expect(findTerminalSearchMatches(rows, "a+(b", insensitiveLiteral)).toEqual({
      matches: [match(0, 1, 5)],
      truncated: false,
    });
    expect(findTerminalSearchMatches(rows, ".", insensitiveLiteral)).toEqual({
      matches: [],
      truncated: false,
    });
  });

  it("handles matches spanning wrapped rows, including an empty row", () => {
    const rows = { texts: ["0123456789", "", "WRAP"], wraps: [true, true, false] };
    expect(findTerminalSearchMatches(rows, "89WRAP", insensitiveLiteral)).toEqual({
      matches: [{ start: { row: 0, offset: 8 }, end: { row: 2, offset: 4 } }],
      truncated: false,
    });
  });

  it("skips trimmed trailing whitespace", () => {
    const rows = { texts: ["hello   ", "world"], wraps: [false, false] };
    expect(findTerminalSearchMatches(rows, "   ", insensitiveLiteral)).toEqual({
      matches: [],
      truncated: false,
    });
  });

  it("truncates only when matches exceed the maximum", () => {
    const texts = Array.from({ length: MAX_TERMINAL_SEARCH_MATCHES + 1 }, () => "match");
    const exactRows: TerminalSearchRows = {
      texts: texts.slice(0, MAX_TERMINAL_SEARCH_MATCHES),
      wraps: texts.map(() => false),
    };
    const exactResult = findTerminalSearchMatches(exactRows, "match", insensitiveLiteral);
    expect([exactResult.matches.length, exactResult.truncated]).toEqual([
      MAX_TERMINAL_SEARCH_MATCHES,
      false,
    ]);
    const overflowResult = findTerminalSearchMatches(
      { texts, wraps: exactRows.wraps },
      "match",
      insensitiveLiteral,
    );
    expect([overflowResult.matches.length, overflowResult.truncated]).toEqual([
      MAX_TERMINAL_SEARCH_MATCHES,
      true,
    ]);
  });
});

describe("terminalSearchHighlights", () => {
  it("maps wide-character offsets", () => {
    const rows: TerminalSearchCellRow[] = [
      {
        cells: [
          { text: "漢", wide: 1 },
          { text: "", wide: 2 },
          { text: "x", wide: 0 },
        ],
      },
    ];
    expect(terminalSearchHighlights([match(0, 0, 1)], 0, 0, rows)).toEqual([
      { row: 0, startColumn: 0, endColumn: 1, active: true },
    ]);
  });

  it("clips multi-row highlights", () => {
    const rows = [{ cells: [{ text: "a", wide: 0 }] }, { cells: [{ text: "b", wide: 0 }] }];
    expect(
      terminalSearchHighlights(
        [{ start: { row: 0, offset: 0 }, end: { row: 3, offset: 5 } }],
        0,
        1,
        rows,
      ),
    ).toEqual([
      { row: 0, startColumn: 0, endColumn: 0, active: true },
      { row: 1, startColumn: 0, endColumn: 0, active: true },
    ]);
  });

  it("sets the active flag", () => {
    const rows = [
      { cells: [{ text: "first", wide: 0 }] },
      { cells: [{ text: "second", wide: 0 }] },
    ];
    expect(terminalSearchHighlights([match(0, 0, 5), match(1, 0, 6)], 1, 0, rows)).toEqual([
      { row: 0, startColumn: 0, endColumn: 0, active: false },
      { row: 1, startColumn: 0, endColumn: 0, active: true },
    ]);
  });
});

describe("initialTerminalSearchIndex", () => {
  it("returns -1 when no matches", () => {
    expect(initialTerminalSearchIndex([], 0, 10)).toBe(-1);
  });

  it("returns last match below viewport bottom", () => {
    expect(
      initialTerminalSearchIndex([match(0, 0, 5), match(5, 0, 5), match(15, 0, 5)], 10, 10),
    ).toBe(2);
  });

  it("returns 0 if no matches precede the viewport bottom", () => {
    expect(initialTerminalSearchIndex([match(20, 0, 5)], 0, 10)).toBe(0);
  });
});

describe("stepTerminalSearchIndex", () => {
  it("returns -1 when no matches", () => expect(stepTerminalSearchIndex(0, 0, 1)).toBe(-1));

  it("wraps forward", () => expect(stepTerminalSearchIndex(4, 5, 1)).toBe(0));

  it("wraps backward", () => expect(stepTerminalSearchIndex(0, 5, -1)).toBe(4));

  it("starts forward", () => expect(stepTerminalSearchIndex(-1, 5, 1)).toBe(0));

  it("starts backward", () => expect(stepTerminalSearchIndex(-1, 5, -1)).toBe(4));
});

describe("closestTerminalSearchIndex", () => {
  it("returns -1 when empty or no previous match", () => {
    expect(closestTerminalSearchIndex([], null)).toBe(-1);
  });

  it("finds the next match at the previous position", () => {
    expect(closestTerminalSearchIndex([match(0, 0, 5), match(5, 0, 5)], match(5, 0, 5))).toBe(1);
  });
});

describe("terminalSearchScrollDelta", () => {
  const scrollbar = { total: 100, offset: 0, len: 20 };

  it("returns 0 when visible", () =>
    expect(terminalSearchScrollDelta(match(5, 0, 5), scrollbar)).toBe(0));

  it("centers row 50", () =>
    expect(terminalSearchScrollDelta(match(50, 0, 5), scrollbar)).toBe(41));

  it("clamps row 95", () => expect(terminalSearchScrollDelta(match(95, 0, 5), scrollbar)).toBe(80));
});
