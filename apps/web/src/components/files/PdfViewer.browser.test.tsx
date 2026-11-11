import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "~/index.css";

// Vite serves the worker module through its transform with an inline source map (6.8 MB for
// a 1.3 MB file), which dominated this test under CPU contention. A blob of the raw file is the
// same code without the dev-server cost.
vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

import PdfViewer from "./PdfViewer";

// Page 1 is a short banner whose title is drawn in two runs with a font change, so pdf.js
// splits it into two text spans. Page 2 is a letter page rotated a quarter turn.
function twoPagePdf() {
  const pages = [
    {
      box: "0 0 612 140",
      rotate: 0,
      text: "BT /F1 24 Tf 30 70 Td (Quarter) Tj /F2 24 Tf (ly outlook) Tj ET",
    },
    { box: "0 0 612 792", rotate: 90, text: "BT /F1 24 Tf 30 700 Td (Budget and risks) Tj ET" },
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    ...pages.flatMap(({ box, rotate, text }, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Rotate ${rotate} /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([source], { type: "application/pdf" });
}

it("fits the width, then finds split and rotated text and jumps to its page", async () => {
  const url = URL.createObjectURL(twoPagePdf());
  try {
    const container = document.createElement("div");
    container.style.cssText = "display:flex;width:500px;height:600px";
    await using screen = await render(<PdfViewer src={url} title="Planning PDF" />, {
      container,
    });
    // The milestone is pdf.js booting its worker and parsing the document, not a frame count.
    await expect.element(screen.getByText("1 / 2 pages"), { timeout: 10_000 }).toBeVisible();
    const region = screen.container.querySelector<HTMLElement>('[role="region"]')!;
    // Fit width follows the measured viewport, which settles once the scrollbar appears.
    await vi.waitFor(() => {
      const canvas = region.querySelector('canvas[aria-label="Page 1"]')!;
      expect(canvas.getBoundingClientRect().width).toBe(region.clientWidth - 32);
      expect(region.scrollWidth).toBe(region.clientWidth);
    });

    const find = screen.getByRole("searchbox", { name: "Find in PDF" });
    await find.fill("quarterly outlook");
    await expect.element(screen.getByRole("status")).toHaveTextContent("1/1");
    await vi.waitFor(() =>
      expect(
        Array.from(region.querySelectorAll(".pdf-find-match"), (span) => span.textContent),
      ).toEqual(["Quarter", "ly outlook"]),
    );

    await find.fill("budget");
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    await expect.element(screen.getByRole("status")).toHaveTextContent("1/1");
    const rotated = await vi.waitFor(() => {
      const span = Array.from(region.querySelectorAll("[data-pdf-text-layer] span")).find(
        (node) => node.textContent === "Budget and risks",
      );
      expect(span).toBeDefined();
      return span!;
    });
    // The rotated page's text runs top to bottom inside the page, so a selection lands on it.
    const textBounds = rotated.getBoundingClientRect();
    const pageBounds = rotated.closest("[data-pdf-text-layer]")!.getBoundingClientRect();
    expect(textBounds.height).toBeGreaterThan(textBounds.width);
    expect(textBounds.width).toBeGreaterThan(0);
    expect(textBounds.left).toBeGreaterThanOrEqual(pageBounds.left - 1);
    expect(textBounds.top).toBeGreaterThanOrEqual(pageBounds.top - 1);
    expect(textBounds.right).toBeLessThanOrEqual(pageBounds.right + 1);
    expect(textBounds.bottom).toBeLessThanOrEqual(pageBounds.bottom + 1);
    expect(getComputedStyle(rotated).userSelect).toBe("text");
    const range = document.createRange();
    range.selectNodeContents(rotated);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("Budget and risks");
    selection.removeAllRanges();

    await find.fill(" ");
    await expect.element(screen.getByRole("status")).toHaveTextContent("0/0");
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("restores page, within-page offset and zoom after a remount", async () => {
  const url = URL.createObjectURL(twoPagePdf());
  const viewer = (mount: number, positionKey: string) => (
    <div className="flex h-[300px] w-[320px]">
      <PdfViewer key={mount} src={url} title="Restored PDF" positionKey={positionKey} />
    </div>
  );
  try {
    await using screen = await render(viewer(1, "restore:a"));
    await expect.element(screen.getByText("1 / 2 pages")).toBeVisible();
    await screen.getByRole("button", { name: "Zoom in", exact: true }).click();
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    const region = () => screen.getByRole("region", { name: "Restored PDF" }).element();
    const top = region().scrollTop + 40;
    const scrolled = new Promise((resolve) =>
      region().addEventListener("scroll", resolve, { once: true }),
    );
    region().scrollTop = top;
    await scrolled;
    await vi.waitFor(() => expect(region().scrollTop).toBeCloseTo(top, 0));
    const zoom = screen.container.textContent!.match(/\d+%/)![0];

    await screen.rerender(viewer(2, "restore:a"));
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    await vi.waitFor(() => expect(region().scrollTop).toBeCloseTo(top, 0));
    await vi.waitFor(() => expect(screen.container.textContent).toContain(zoom));

    await screen.getByRole("button", { name: "Fit width", exact: true }).click();
    await vi.waitFor(() => {
      const canvas = region().querySelector("canvas")!;
      expect(canvas.getBoundingClientRect().width).toBe(region().clientWidth - 32);
    });
    const fitTop = region().scrollTop;
    await screen.rerender(viewer(3, "restore:a"));
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    await vi.waitFor(() => {
      expect(region().querySelector("canvas")!.getBoundingClientRect().width).toBe(
        region().clientWidth - 32,
      );
      expect(region().scrollTop).toBeCloseTo(fitTop, 0);
    });

    await screen.rerender(viewer(4, "restore:b"));
    await expect.element(screen.getByText("1 / 2 pages")).toBeVisible();
    await expect.element(screen.getByText("Fit width")).toBeVisible();
  } finally {
    URL.revokeObjectURL(url);
  }
});
