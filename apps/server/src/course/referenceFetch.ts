// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Agent } from "undici";
import { isPublicFaviconHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import { auditDownload, type DownloadAuditContext } from "./downloadAudit.ts";

export class CourseReferenceFetchError extends Schema.TaggedError<CourseReferenceFetchError>()(
  "CourseReferenceFetchError",
  { message: Schema.String },
) {}

export interface ReferenceImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
}

export interface ReferenceFetchResult {
  readonly url: string;
  readonly title?: string;
  readonly text?: string;
  readonly links?: ReadonlyArray<{ readonly text: string; readonly href: string }>;
  readonly pageCount?: number;
  readonly pages?: ReadonlyArray<{ readonly page: number; readonly text: string }>;
  readonly images?: ReadonlyArray<ReferenceImage>;
}

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const validateUrl = (raw: string | URL) => {
  const url = typeof raw === "string" ? new URL(raw) : raw;
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
    throw new Error("Only public http(s) URLs without userinfo are allowed.");
  if (!isPublicFaviconHost(url.hostname)) throw new Error("The URL host is not public.");
  return url;
};

const checkedDispatcher = async (
  hostname: string,
  lookup: typeof NodeDnsPromises.lookup = NodeDnsPromises.lookup,
) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkHost(address)))
    throw new Error("The URL resolves to a private network address.");
  const address = addresses[0]!;
  return new Agent({
    connect: {
      lookup: ((
        _host: string,
        _options: unknown,
        callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
      ) => callback(null, address.address, address.family)) as never,
    },
  });
};

const readBody = async (response: Response) => {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("Response exceeds the 25 MB limit.");
  if (!response.body) throw new Error("Response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BYTES) throw new Error("Response exceeds the 25 MB limit.");
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
};

const driveRewrite = (url: URL) => {
  const match = url.pathname.match(/^\/file\/d\/([^/]+)(?:\/|$)/);
  if (!match || !url.hostname.endsWith("google.com")) return url;
  return new URL(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(match[1]!)}`);
};

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (name: string, body: Uint8Array) => {
  const type = Buffer.from(name);
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  type.copy(out, 4);
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([type, Buffer.from(body)])), body.length + 8);
  return out;
};
const encodePng = (pixels: Uint8Array, width: number, height: number) => {
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
        const h = Buffer.alloc(13);
        h.writeUInt32BE(width, 0);
        h.writeUInt32BE(height, 4);
        h[8] = 8;
        h[9] = 0;
        return h;
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
  return { data: encodePng(pixels, width, height).toString("base64"), width, height };
};

const extractPdf = async (bytes: Uint8Array, requested: ReadonlyArray<number>) => {
  // @ts-expect-error pdfjs-dist ships no types for its worker module.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isOffscreenCanvasSupported: false,
  }).promise;
  const pages: { page: number; text: string }[] = [];
  const images: ReferenceImage[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({
      page: pageNumber,
      text: content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    });
    if (!requested.includes(pageNumber)) continue;
    const ops = await page.getOperatorList();
    const candidates = ops.fnArray
      .map((fn: number, i: number) => ({ fn, args: ops.argsArray[i] }))
      .filter((x: { fn: number }) => x.fn === pdfjs.OPS.paintImageXObject);
    let largest: { width: number; height: number; kind: number; data: Uint8Array } | undefined;
    for (const candidate of candidates) {
      const id = candidate.args[0];
      const objects = String(id).startsWith("g_") ? page.commonObjs : page.objs;
      const image = await new Promise<any>((resolve) => objects.get(id, resolve));
      if (image && (!largest || image.width * image.height > largest.width * largest.height))
        largest = image;
    }
    if (largest) {
      const png = imageToPng(largest);
      images.push({ type: "image", mimeType: "image/png", ...png });
    }
  }
  const destroy = Reflect.get(document, "destroy");
  if (typeof destroy === "function") await destroy.call(document);
  return { pageCount: document.numPages, pages, images };
};

export const fetchCourseReference = Effect.fn("course.fetchReference")(function* (input: {
  readonly url: string;
  readonly pages?: ReadonlyArray<number>;
  readonly fetchImpl?: typeof fetch;
  readonly lookup?: typeof NodeDnsPromises.lookup;
  readonly audit?: DownloadAuditContext;
}): Generator<
  Effect.Effect<ReferenceFetchResult, CourseReferenceFetchError>,
  ReferenceFetchResult,
  never
> {
  return yield* Effect.tryPromise({
    try: async () => {
      const fetchImpl = input.fetchImpl ?? fetch;
      let url = driveRewrite(validateUrl(input.url));
      let response: Response | undefined;
      const hops: { url: string; status: number | null; ips: string[] }[] = [];
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const dispatcher = await checkedDispatcher(url.hostname, input.lookup);
        response = await fetchImpl(url.toString(), {
          redirect: "manual",
          dispatcher,
          signal: AbortSignal.timeout(30_000),
        } as unknown as RequestInit);
        hops.push({ url: url.toString(), status: response.status, ips: [] });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location || hop === MAX_REDIRECTS) throw new Error("Too many redirects.");
        url = driveRewrite(validateUrl(new URL(location, url.toString())));
      }
      if (!response) throw new Error("No response.");
      const body = await readBody(response);
      if (input.audit)
        await auditDownload(input.audit, {
          url: input.url,
          hops,
          status: response.status,
          bytes: body.byteLength,
          contentType: response.headers.get("content-type"),
          body,
        });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("pdf") || url.pathname.toLowerCase().endsWith(".pdf")) {
        const pages = [
          ...new Set(
            (input.pages?.length ? input.pages : [1, 2, 3, 4]).filter((page) => page >= 1),
          ),
        ].slice(0, 4);
        return { url: url.toString(), ...(await extractPdf(body, pages)) };
      }
      const html = body.toString("utf8");
      const title = html
        .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
        ?.replace(/\s+/g, " ")
        .trim();
      const text = html
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 20_000);
      const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
        .slice(0, 300)
        .map((match) => ({
          href: new URL(match[1]!, url).toString(),
          text: match[2]!
            .replace(/<[^>]+>/g, "")
            .replace(/\s+/g, " ")
            .trim(),
        }));
      return { url: url.toString(), ...(title ? { title } : {}), text, links };
    },
    catch: (cause) => {
      if (input.audit) void auditDownload(input.audit, { url: input.url, error: String(cause) });
      return new CourseReferenceFetchError({ message: String(cause) });
    },
  });
});
