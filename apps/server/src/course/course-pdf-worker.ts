// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off
import * as NodeZlib from "node:zlib";

const MAX_PDF_IMAGE_PIXELS = 16 * 1024 * 1024;

const chunk = (name: string, body: Uint8Array) => {
  const type = Buffer.from(name);
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  type.copy(out, 4);
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(NodeZlib.crc32(Buffer.concat([type, Buffer.from(body)])), body.length + 8);
  return out;
};

export const encodeGrayscalePng = (pixels: Uint8Array, width: number, height: number) => {
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (width + 1)] = 0;
    rows.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk(
      "IHDR",
      (() => {
        const header = Buffer.alloc(13);
        header.writeUInt32BE(width, 0);
        header.writeUInt32BE(height, 4);
        header[8] = 8;
        return header;
      })(),
    ),
    chunk("IDAT", NodeZlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const imageToPng = (image: { width: number; height: number; kind: number; data: Uint8Array }) => {
  const scale = Math.min(1, 1200 / image.width);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const pixels = new Uint8Array(width * height);
  const channels = image.kind === 3 ? 4 : image.kind === 2 ? 3 : 1;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor(x / scale));
      const sy = Math.min(image.height - 1, Math.floor(y / scale));
      const at = (sy * image.width + sx) * channels;
      pixels[y * width + x] =
        image.kind === 1
          ? image.data[sy * Math.ceil(image.width / 8) + (sx >> 3)]! & (128 >> (sx & 7))
            ? 0
            : 255
          : Math.round(
              0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!,
            );
    }
  return { data: encodeGrayscalePng(pixels, width, height).toString("base64"), width, height };
};

export const extractRequestedPdfPages = async (bytes: Uint8Array, requested: readonly number[]) => {
  // @ts-expect-error pdfjs-dist ships no types for its worker module.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isOffscreenCanvasSupported: false,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
  }).promise;
  const pages: { page: number; text: string }[] = [];
  const images: {
    type: "image";
    data: string;
    mimeType: "image/png";
    width: number;
    height: number;
  }[] = [];
  let textRemaining = 20_000;
  try {
    for (const pageNumber of [...new Set(requested)]
      .filter((page) => page >= 1 && page <= document.numPages)
      .slice(0, 4)) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, textRemaining);
      textRemaining -= pageText.length;
      pages.push({ page: pageNumber, text: pageText });
      if (textRemaining <= 0) continue;
      const ops = await page.getOperatorList();
      const candidates = ops.fnArray
        .map((fn: number, index: number) => ({ fn, args: ops.argsArray[index] }))
        .filter((entry: { fn: number }) => entry.fn === pdfjs.OPS.paintImageXObject);
      let largest: { width: number; height: number; kind: number; data: Uint8Array } | undefined;
      for (const candidate of candidates) {
        const id = candidate.args[0];
        const objects = String(id).startsWith("g_") ? page.commonObjs : page.objs;
        const image = await new Promise<any>((resolve) => objects.get(id, resolve));
        if (image && (!largest || image.width * image.height > largest.width * largest.height))
          largest = image;
      }
      if (largest) images.push({ type: "image", mimeType: "image/png", ...imageToPng(largest) });
    }
    return {
      pageCount: document.numPages,
      pages,
      images,
    };
  } finally {
    const destroy = Reflect.get(document, "destroy");
    if (typeof destroy === "function") await destroy.call(document);
  }
};

if (
  process.argv[1]?.endsWith("course-pdf-worker.ts") ||
  process.argv[1]?.endsWith("course-pdf-worker.mjs")
) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    bytes: string;
    pages: number[];
  };
  process.stdout.write(
    JSON.stringify(await extractRequestedPdfPages(Buffer.from(input.bytes, "base64"), input.pages)),
  );
}
