import { describe, expect, it } from "vite-plus/test";

import { renderTablePng } from "./tablePng";

const MARGIN = 16;
const BACKDROP = [12, 34, 56] as const;

interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly origin: DOMRect;
  /** Whether any pixel inside a viewport rect differs from the backdrop. */
  readonly hasInk: (rect: DOMRect) => boolean;
  readonly at: (x: number, y: number) => readonly number[];
  /** Alpha of the image's last pixel. */
  readonly cornerAlpha: number;
}

async function readPng(blob: Blob, table: HTMLTableElement): Promise<Pixels> {
  expect(blob.type).toBe("image/png");
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const origin = table.getBoundingClientRect();
  const scale = bitmap.width / (origin.width + MARGIN * 2);
  const index = (x: number, y: number) =>
    (Math.round((y - origin.top + MARGIN) * scale) * bitmap.width +
      Math.round((x - origin.left + MARGIN) * scale)) *
    4;
  const at = (x: number, y: number) => Array.from(data.subarray(index(x, y), index(x, y) + 3));
  const hasInk = (rect: DOMRect) => {
    for (let y = rect.top; y < rect.bottom; y += 1 / scale) {
      for (let x = rect.left; x < rect.right; x += 1 / scale) {
        const pixel = at(x, y);
        if (pixel.some((channel, i) => Math.abs(channel - BACKDROP[i]!) > 24)) return true;
      }
    }
    return false;
  };
  return {
    width: bitmap.width,
    height: bitmap.height,
    origin,
    hasInk,
    at,
    cornerAlpha: data[data.length - 1]!,
  };
}

/** Mounts a table over a known backdrop; disposing removes it. */
function mountTable(cells: string, style = "") {
  const host = document.createElement("div");
  host.style.cssText = `background: rgb(${BACKDROP.join(",")}); color: white; padding: 40px; font: 14px/20px sans-serif;`;
  host.innerHTML = `<table style="border-collapse: collapse; ${style}"><tbody>${cells}</tbody></table>`;
  document.body.append(host);
  return {
    table: host.querySelector("table")!,
    [Symbol.dispose]: () => host.remove(),
  };
}

function textRects(element: Element): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(element);
  return [...range.getClientRects()];
}

describe("renderTablePng", () => {
  it("draws the table at its layout size over the backdrop behind it", async () => {
    using mounted = mountTable(
      `<tr><td style="border-bottom: 2px solid rgb(255, 0, 0); padding: 8px">Name</td><td style="padding: 8px"></td></tr>`,
      // A fractional height, so the canvas size is rounded.
      "width: 300px; height: 40.6px",
    );
    const { table } = mounted;
    const pixels = await readPng(await renderTablePng(table), table);
    expect(pixels.width).toBe(Math.floor((pixels.origin.width + MARGIN * 2) * devicePixelRatio));
    expect(pixels.height).toBe(Math.floor((pixels.origin.height + MARGIN * 2) * devicePixelRatio));
    expect(pixels.cornerAlpha).toBe(255);

    // The margin shows the backdrop, the rule keeps its color, and the empty cell stays empty.
    expect(pixels.at(pixels.origin.left - MARGIN / 2, pixels.origin.top)).toEqual([...BACKDROP]);
    const [nameCell, emptyCell] = table.querySelectorAll("td");
    const name = nameCell!.getBoundingClientRect();
    expect(pixels.at(name.left + name.width / 2, name.bottom - 1)).toEqual([255, 0, 0]);
    expect(pixels.hasInk(textRects(nameCell!)[0]!)).toBe(true);
    const empty = emptyCell!.getBoundingClientRect();
    expect(pixels.hasInk(new DOMRect(empty.left, empty.top, empty.width, empty.height - 2))).toBe(
      false,
    );
  });

  it("draws every line of wrapped text where layout put it", async () => {
    using mounted = mountTable(
      `<tr><td style="width: 100px">alpha beta gamma delta epsilon zeta eta theta iota kappa</td><td style="padding-left: 24px">done</td></tr>`,
    );
    const { table } = mounted;
    const pixels = await readPng(await renderTablePng(table), table);
    const lines = textRects(table.querySelector("td")!);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(pixels.hasInk(line)).toBe(true);
    // Nothing spills into the gap after the wrapped column.
    const done = table.querySelectorAll("td")[1]!.getBoundingClientRect();
    expect(pixels.hasInk(new DOMRect(done.left, done.top, 20, done.height))).toBe(false);
  });

  it("cuts an overflowing chip with an ellipsis inside the chip", async () => {
    using mounted = mountTable(
      `<tr><td><span id="chip" style="display: inline-block; max-width: 80px; overflow-x: clip; text-overflow: ellipsis; white-space: nowrap">a-very-long-file-name.tsx</span></td><td style="padding-left: 60px">x</td></tr>`,
    );
    const { table } = mounted;
    const pixels = await readPng(await renderTablePng(table), table);
    const chipElement = document.getElementById("chip")!;
    const chip = chipElement.getBoundingClientRect();
    // Chromium reports the visible part of the cut text as its own, shorter rect.
    const visibleRight = Math.min(...textRects(chipElement).map((rect) => rect.right));
    expect(visibleRight).toBeLessThan(chip.right - 4);
    const tail = (top: number, bottom: number) =>
      new DOMRect(visibleRight + 1, top, chip.right - visibleRight - 1, bottom - top);
    // After the last whole glyph only the ellipsis's dots remain: low on the line, not letters.
    expect(pixels.hasInk(tail(chip.top, chip.top + chip.height * 0.45))).toBe(false);
    expect(pixels.hasInk(tail(chip.top + chip.height * 0.45, chip.bottom))).toBe(true);
    expect(pixels.hasInk(new DOMRect(chip.right, chip.top, 50, chip.height))).toBe(false);
  });

  it("clips a block's background to the box that hides its overflow", async () => {
    using mounted = mountTable(
      `<tr><td><div id="clip" style="width: 60px; overflow: hidden"><div style="width: 120px; height: 20px; background: rgb(255, 0, 0)"></div></div></td><td style="padding-left: 80px">x</td></tr>`,
    );
    const { table } = mounted;
    const pixels = await readPng(await renderTablePng(table), table);
    const clip = document.getElementById("clip")!.getBoundingClientRect();
    expect(pixels.at(clip.left + 30, clip.top + 10)).toEqual([255, 0, 0]);
    expect(pixels.hasInk(new DOMRect(clip.right + 1, clip.top, 50, clip.height))).toBe(false);
  });

  it("draws a sprite icon from the shared symbol it points at", async () => {
    const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    sprite.style.display = "none";
    sprite.innerHTML = `<symbol id="test-icon" viewBox="0 0 10 10"><rect width="10" height="10" fill="currentColor"/></symbol>`;
    document.body.append(sprite);
    using _sprite = { [Symbol.dispose]: () => sprite.remove() };
    using mounted = mountTable(
      `<tr><td><svg id="icon" width="20" height="20" style="color: rgb(0, 255, 0)"><use href="#test-icon"/></svg></td></tr>`,
    );
    const { table } = mounted;
    const pixels = await readPng(await renderTablePng(table), table);
    const icon = document.getElementById("icon")!.getBoundingClientRect();
    expect(pixels.at(icon.left + 10, icon.top + 10)).toEqual([0, 255, 0]);
  });

  it("leaves visually hidden text out", async () => {
    using mounted = mountTable(
      `<tr><td id="cell" style="position: relative; width: 80px; height: 20px"><span style="position: absolute; inset: 0; clip-path: inset(50%)">hidden label</span></td></tr>`,
    );
    const { table } = mounted;
    const pixels = await readPng(await renderTablePng(table), table);
    expect(pixels.hasInk(document.getElementById("cell")!.getBoundingClientRect())).toBe(false);
  });
});
