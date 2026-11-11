// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalTimers:off schemaClassMissingBrand:off
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Agent, fetch as undiciFetch } from "undici";
import { isPublicFaviconHost } from "@t3tools/shared/hostClassification";
import { auditDownload, type DownloadAuditContext } from "./downloadAudit.ts";

export class CourseReferenceFetchError extends Schema.TaggedError<CourseReferenceFetchError>()(
  "CourseReferenceFetchError",
  { message: Schema.String },
) {}

class ReferenceBlockedError extends Schema.TaggedError<ReferenceBlockedError>()(
  "ReferenceBlockedError",
  { reason: Schema.String },
) {}
const isReferenceBlockedError = Schema.is(ReferenceBlockedError);

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
  readonly skippedImages?: number;
}

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_PDF_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_PDF_TOTAL_PIXELS = 64 * 1024 * 1024;
const MAX_PDF_IMAGE_OPS_PER_PAGE = 8;
const PDF_TIMEOUT_MS = 30_000;

const validateUrl = (raw: string | URL) => {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new ReferenceBlockedError({
      reason: "Only public http(s) URLs without userinfo are allowed.",
    });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
    throw new ReferenceBlockedError({
      reason: "Only public http(s) URLs without userinfo are allowed.",
    });
  if (!isPublicFaviconHost(url.hostname))
    throw new ReferenceBlockedError({ reason: "The URL host is not public." });
  return url;
};

type DispatcherLookup = (
  host: string,
  options: { readonly all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | ReadonlyArray<{ address: string; family: number }>,
    family?: number,
  ) => void,
) => void;

export const checkedDispatcher = async (
  hostname: string,
  lookup: typeof NodeDnsPromises.lookup = NodeDnsPromises.lookup,
) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const blocked =
    !addresses.length || addresses.some(({ address }) => !isPublicFaviconHost(address));
  const address = addresses[0]!;
  const pinnedLookup: DispatcherLookup = (_host, options, callback) =>
    options?.all
      ? callback(
          null,
          addresses.map(({ address: value, family }) => ({ address: value, family })),
        )
      : callback(null, address.address, address.family);
  return {
    ips: addresses.map(({ address }) => address),
    connectLookup: pinnedLookup,
    dispatcher: blocked
      ? undefined
      : new Agent({
          connect: { lookup: pinnedLookup as never },
        }),
    blocked,
  };
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
  return { data: encodeGrayscalePng(pixels, width, height).toString("base64"), width, height };
};

const estimatePdfImages = (bytes: Uint8Array) => {
  const source = Buffer.from(bytes).toString("latin1");
  let count = 0;
  let pixels = 0;
  for (const dictionary of source.matchAll(
    /<<[\s\S]{0,2500}?\/Subtype\s*\/Image[\s\S]{0,2500}?>>/g,
  )) {
    const width = Number(dictionary[0].match(/\/Width\s+(\d+)/)?.[1] ?? 0);
    const height = Number(dictionary[0].match(/\/Height\s+(\d+)/)?.[1] ?? 0);
    if (width > 0 && height > 0) {
      count += 1;
      pixels += width * height;
    }
  }
  return { count, pixels };
};

export const extractPdf = async (bytes: Uint8Array, requested: ReadonlyArray<number>) => {
  // @ts-expect-error pdfjs-dist ships no types for its worker module.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isOffscreenCanvasSupported: false,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
  }).promise;
  const pages: { page: number; text: string }[] = [];
  const images: ReferenceImage[] = [];
  let textRemaining = 20_000;
  let remainingPixels = MAX_PDF_TOTAL_PIXELS;
  let skippedImages = 0;
  const estimated = estimatePdfImages(bytes);
  const skipPdfImages =
    estimated.count > MAX_PDF_IMAGE_OPS_PER_PAGE || estimated.pixels > MAX_PDF_TOTAL_PIXELS;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    if (!requested.includes(pageNumber)) continue;
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, textRemaining);
    textRemaining -= pageText.length;
    pages.push({ page: pageNumber, text: pageText });
    if (skipPdfImages) {
      skippedImages += estimated.count;
      continue;
    }
    const ops = await page.getOperatorList();
    const candidates = ops.fnArray
      .map((fn: number, i: number) => ({ fn, args: ops.argsArray[i] }))
      .filter((x: { fn: number }) => x.fn === pdfjs.OPS.paintImageXObject);
    let largest: { width: number; height: number; kind: number; data: Uint8Array } | undefined;
    for (const [candidateIndex, candidate] of candidates.entries()) {
      if (candidateIndex >= MAX_PDF_IMAGE_OPS_PER_PAGE) {
        skippedImages += candidates.length - candidateIndex;
        break;
      }
      const id = candidate.args[0];
      const objects = String(id).startsWith("g_") ? page.commonObjs : page.objs;
      const image = await new Promise<any>((resolve) => objects.get(id, resolve));
      if (!image) continue;
      const pixels = image.width * image.height;
      if (pixels > remainingPixels) {
        skippedImages += 1;
        continue;
      }
      if (!largest || pixels > largest.width * largest.height) largest = image;
    }
    if (largest) {
      const png = imageToPng(largest);
      images.push({ type: "image", mimeType: "image/png", ...png });
      remainingPixels -= largest.width * largest.height;
    }
  }
  const destroy = Reflect.get(document, "destroy");
  if (typeof destroy === "function") await destroy.call(document);
  return {
    pageCount: document.numPages,
    pages,
    images,
    ...(skippedImages ? { skippedImages } : {}),
  };
};

const extractPdfWithTimeout = (bytes: Uint8Array, requested: ReadonlyArray<number>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("PDF extraction exceeded the 30 second limit.")),
      PDF_TIMEOUT_MS,
    );
  });
  return Promise.race([extractPdf(bytes, requested), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
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
      const fetchImpl: typeof fetch = input.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
      let url = new URL("http://invalid.local/");
      let response: Response | undefined;
      const hops: { url: string; status: number | null; ips: string[] }[] = [];
      let body: Buffer | undefined;
      let failure: unknown;
      try {
        url = driveRewrite(validateUrl(input.url));
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          const existingHop = hops.at(-1)?.url === url.toString() ? hops.at(-1) : undefined;
          const checked = await checkedDispatcher(
            url.hostname.replace(/^\[|\]$/g, ""),
            input.lookup,
          );
          const hopEntry = existingHop ?? { url: url.toString(), status: null, ips: checked.ips };
          hopEntry.ips = checked.ips;
          if (!existingHop) hops.push(hopEntry);
          if (checked.blocked)
            throw new ReferenceBlockedError({
              reason: "The URL resolves to a private network address.",
            });
          response = await fetchImpl(url.toString(), {
            redirect: "manual",
            dispatcher: checked.dispatcher,
            signal: AbortSignal.timeout(30_000),
          } as unknown as RequestInit);
          hopEntry.status = response.status;
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get("location");
          if (!location || hop === MAX_REDIRECTS) throw new Error("Too many redirects.");
          const target = new URL(location, url.toString());
          const targetText = target.toString();
          if (hops.at(-1)?.url !== targetText)
            hops.push({ url: targetText, status: null, ips: [] });
          url = driveRewrite(validateUrl(target));
        }
        if (!response) throw new Error("No response.");
        body = await readBody(response);
        if (response.status < 200 || response.status >= 300)
          throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (
          contentType.includes("pdf") ||
          url.pathname.toLowerCase().endsWith(".pdf") ||
          body.subarray(0, 5).toString("ascii") === "%PDF-"
        ) {
          const pages = [
            ...new Set(
              (input.pages?.length ? input.pages : [1, 2, 3, 4]).filter((page) => page >= 1),
            ),
          ].slice(0, 4);
          return { url: url.toString(), ...(await extractPdfWithTimeout(body, pages)) };
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
          .map((match) =>
            URL.canParse(match[1]!, url.toString())
              ? {
                  href: new URL(match[1]!, url).toString(),
                  text: match[2]!
                    .replace(/<[^>]+>/g, "")
                    .replace(/\s+/g, " ")
                    .trim(),
                }
              : undefined,
          )
          .filter((link): link is { href: string; text: string } => link !== undefined);
        return { url: url.toString(), ...(title ? { title } : {}), text, links };
      } catch (cause) {
        failure = cause;
        throw cause;
      } finally {
        if (input.audit)
          await auditDownload(input.audit, {
            url: input.url,
            hops,
            status: response?.status ?? null,
            bytes: body?.byteLength ?? 0,
            contentType: response?.headers.get("content-type") ?? null,
            ...(body === undefined ? {} : { body }),
            ...(isReferenceBlockedError(failure) ? { blocked: failure.reason } : {}),
            ...(failure !== undefined && !isReferenceBlockedError(failure)
              ? { error: String(failure) }
              : {}),
          });
      }
    },
    catch: (cause) =>
      new CourseReferenceFetchError({
        message: isReferenceBlockedError(cause) ? cause.reason : String(cause),
      }),
  });
});
