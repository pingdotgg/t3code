import { describe, expect, it } from "vite-plus/test";
import {
  currentPdfPage,
  pdfFindIncludes,
  pdfFindMatchRuns,
  pdfPageOffsets,
  pdfPageScrollTop,
  pdfPageText,
  pdfPageWidth,
  stepPdfZoom,
  visiblePdfPages,
} from "./pdfLayout";

describe("pdfPageWidth", () => {
  it("fits the page to the viewport minus its gutters until a zoom is chosen", () => {
    expect(pdfPageWidth(500, 612, null)).toEqual({ width: 468, scale: 468 / 612 });
    expect(pdfPageWidth(500, 612, 1.5)).toEqual({ width: 918, scale: 1.5 });
  });

  it("never collapses below one pixel in a tiny viewport", () => {
    expect(pdfPageWidth(10, 612, null).width).toBe(1);
  });
});

describe("stepPdfZoom", () => {
  it("steps by a quarter and clamps to 25%..300%", () => {
    expect(stepPdfZoom(1, 1)).toBe(1.25);
    expect(stepPdfZoom(1, -1)).toBe(0.75);
    expect(stepPdfZoom(2.9, 1)).toBe(3);
    expect(stepPdfZoom(0.3, -1)).toBe(0.25);
  });

  it("starts from the fit-width scale when no zoom is set", () => {
    const { scale } = pdfPageWidth(500, 612, null);
    expect(stepPdfZoom(scale, 1)).toBeCloseTo(468 / 612 + 0.25);
  });
});

describe("mixed-height page layout", () => {
  // A short banner page, a letter page, then a page half as tall as it is wide.
  const ratios = [140 / 612, 792 / 612, 306 / 612];
  const width = 612;
  const offsets = pdfPageOffsets(ratios, width);

  it("stacks pages with a gap before, between, and after them", () => {
    expect(offsets).toEqual([16, 172, 980, 1302]);
  });

  it("reports the page whose bottom is past the top gutter as current", () => {
    expect(currentPdfPage(offsets, 3, 0)).toBe(0);
    expect(currentPdfPage(offsets, 3, 154)).toBe(0);
    expect(currentPdfPage(offsets, 3, 155)).toBe(1);
    expect(currentPdfPage(offsets, 3, 962)).toBe(1);
    expect(currentPdfPage(offsets, 3, 964)).toBe(2);
  });

  it("jumps to each page so that page becomes current", () => {
    for (const index of [0, 1, 2])
      expect(currentPdfPage(offsets, 3, pdfPageScrollTop(offsets, index))).toBe(index);
    expect(pdfPageScrollTop(offsets, 7)).toBe(0);
  });

  it("mounts pages within a viewport above and two below", () => {
    const indexes = (scrollTop: number, height: number) =>
      visiblePdfPages(ratios, offsets, scrollTop, height).map((page) => page.index);
    expect(indexes(0, 100)).toEqual([0, 1]);
    expect(indexes(1100, 100)).toEqual([2]);
    expect(indexes(1100, 900)).toEqual([1, 2]);
    expect(visiblePdfPages(ratios, offsets, 0, 100)[0]).toEqual({ index: 0, ratio: ratios[0] });
  });

  it("scales offsets with the page width when zoomed", () => {
    expect(pdfPageOffsets(ratios, width * 2)).toEqual([16, 312, 1912, 2540]);
  });
});

describe("pdfPageText", () => {
  it("joins text items, adds line ends, and skips marked content", () => {
    expect(
      pdfPageText([
        { str: "Quarter", hasEOL: false },
        { type: "beginMarkedContent" },
        { str: "ly outlook", hasEOL: true },
        { str: "Next", hasEOL: false },
      ]),
    ).toBe("Quarterly outlook\nNext");
  });
});

describe("pdfFindMatchRuns", () => {
  it("highlights every run a match spans when a word is split across spans", () => {
    expect(pdfFindMatchRuns(["Quarter", "ly outlook", " for Q3"], "quarterly OUTLOOK")).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("highlights each separate match", () => {
    expect(pdfFindMatchRuns(["risk", " and ", "budget", " ", "Risk"], "risk")).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it("matches a space in the query across a line end", () => {
    expect(
      pdfFindMatchRuns(["Q3 quarterly", "\n", "outlook", " ahead"], "quarterly outlook"),
    ).toEqual([true, true, true, false]);
  });

  it("matches a word hyphenated across a line end", () => {
    expect(pdfFindMatchRuns(["the quar-", "\n", "terly report"], "quarterly")).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("drops a line-end hyphen after a letter outside the BMP", () => {
    expect(pdfFindMatchRuns(["\u{10400}-", "\n", "\u{10401}"], "\u{10400}\u{10401}")).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("finds the same pages the highlights do", () => {
    const page = "Q3 quarterly\noutlook ahead, the quar-\nterly report";
    expect(pdfFindIncludes(page, "Quarterly  OUTLOOK")).toBe(true);
    expect(pdfFindIncludes(page, "quarterly report")).toBe(true);
    expect(pdfFindIncludes(page, "bud-get")).toBe(false);
    expect(pdfFindIncludes(page, " ")).toBe(false);
  });

  it("highlights nothing for a blank or missing query", () => {
    expect(pdfFindMatchRuns(["a b", "c"], " ")).toEqual([false, false]);
    expect(pdfFindMatchRuns(["a b", "c"], "")).toEqual([false, false]);
    expect(pdfFindMatchRuns(["a b", "c"], "zzz")).toEqual([false, false]);
  });
});
