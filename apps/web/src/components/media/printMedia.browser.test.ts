import { expect, it, vi } from "vite-plus/test";

import { decodeImagePreview } from "../files/decodeImagePreview";
import { printMedia } from "./printMedia";

// Serve the PDF.js worker as a blob instead of through the dev server's transform.
vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

vi.mock("../files/decodeImagePreview", () => ({ decodeImagePreview: vi.fn() }));

type PrintedPage = { readonly page: string; readonly width: string; readonly height: string };
type Printed = {
  readonly title: string;
  readonly pages: readonly PrintedPage[];
  readonly pageSizes: Readonly<Record<string, string>>;
};

// Stands in for the print dialog: records the frame's layout, then reports the dialog closed.
function capturePrints() {
  const printed: Printed[] = [];
  const append = document.body.append.bind(document.body);
  const spy = vi.spyOn(document.body, "append").mockImplementation((...nodes) => {
    for (const node of nodes) {
      if (!(node instanceof HTMLIFrameElement)) continue;
      node.addEventListener("load", () => {
        const view = node.contentWindow!;
        view.print = () => {
          const rules = [...view.document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
          printed.push({
            title: view.document.title,
            pages: [...view.document.images].map((image) => {
              const style = view.getComputedStyle(image);
              return { page: style.page, width: style.width, height: style.height };
            }),
            pageSizes: Object.fromEntries(
              rules
                .filter((rule) => rule.constructor.name === "CSSPageRule")
                .map((rule) => {
                  const page = rule as CSSPageRule;
                  return [page.selectorText, page.style.getPropertyValue("size")];
                }),
            ),
          });
          view.dispatchEvent(new Event("afterprint"));
        };
      });
    }
    append(...nodes);
  });
  return { printed, [Symbol.dispose]: () => spy.mockRestore() };
}

function objectUrl(blob: Blob) {
  const url = URL.createObjectURL(blob);
  return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
}

function png(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
}

function testPdf(boxes: readonly string[]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${boxes.length} /Kids [${boxes.map((_, index) => `${index + 3} 0 R`).join(" ")}] >>`,
    ...boxes.map((box) => `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] >>`),
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

it("settles a print replaced while its last PDF page renders, without printing it", async () => {
  using capture = capturePrints();
  using image = objectUrl(await png(20, 30));
  using pdf = objectUrl(testPdf(["0 0 612 792"]));
  let replacement: Promise<void> | undefined;
  // The page's PNG export runs after its last cancellation check and before its frame exists.
  const toBlob = HTMLCanvasElement.prototype.toBlob;
  using _toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args
  ) {
    replacement ??= printMedia(image.url, "replacement.png", "image");
    toBlob.apply(this, args);
  });

  await expect(printMedia(pdf.url, "story.pdf", "pdf")).resolves.toBeUndefined();
  await replacement;

  expect(capture.printed.map((print) => print.title)).toEqual(["replacement.png"]);
  expect(document.querySelectorAll("iframe")).toHaveLength(0);
});

it("prints each PDF page at its own size and orientation", async () => {
  using capture = capturePrints();
  using pdf = objectUrl(testPdf(["0 0 612 792", "0 0 792 612"]));

  await printMedia(pdf.url, "story.pdf", "pdf");

  expect(capture.printed).toEqual([
    {
      title: "story.pdf",
      pages: [
        { page: "p0", width: "816px", height: "1056px" },
        { page: "p1", width: "1056px", height: "816px" },
      ],
      pageSizes: { p0: "612pt 792pt", p1: "792pt 612pt" },
    },
  ]);
});

it.each([
  { name: "photo.heic", type: "image/heic", heif: true },
  { name: "scan.tiff", type: "image/tiff", heif: false },
])("converts $name before printing it", async ({ name, type, heif }) => {
  vi.mocked(decodeImagePreview)
    .mockReset()
    .mockResolvedValue(await png(30, 20));
  using capture = capturePrints();
  using source = objectUrl(new Blob(["not decodable by the browser"], { type }));

  await printMedia(source.url, name, "image");

  expect(decodeImagePreview).toHaveBeenCalledWith(
    expect.any(String),
    heif,
    expect.any(AbortSignal),
  );
  expect(capture.printed.map((print) => print.title)).toEqual([name]);
});
