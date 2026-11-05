// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ProcessRunner from "../processRunner.ts";
import { openZipArchive } from "../zipArchive.ts";

export class CourseIngestError extends Schema.TaggedError<CourseIngestError>()(
  "CourseIngestError",
  { message: Schema.String },
) {}

export interface IngestedUnit {
  readonly title: string;
  readonly youtubeId?: string;
  /** PDF page range, 1-based inclusive. */
  readonly pages?: readonly [number, number];
  /** `[mm:ss] text` lines (one per ~30 s) for video units, plain page text for PDF units. Absent when fetched lazily. */
  readonly text?: string;
}

export interface IngestedCourse {
  readonly kind: "ocw" | "youtube" | "pdf" | "ours";
  readonly title: string;
  /** The URL or absolute file path the learner gave. */
  readonly source: string;
  readonly license?: string;
  /** Credit line to show, e.g. "MIT OpenCourseWare 18.06, CC BY-NC-SA 4.0". */
  readonly attribution?: string;
  readonly units: ReadonlyArray<IngestedUnit>;
}

export interface IngestOptions {
  readonly ytDlp: boolean;
  readonly workDir: string;
}

const MAX_ZIP_BYTES = 300 * 1024 * 1024;
const MAX_PDF_TEXT = 2 * 1024 * 1024;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

const isCourseIngestError = Schema.is(CourseIngestError);

const fail = (message: string): Effect.Effect<never, CourseIngestError> =>
  Effect.fail(new CourseIngestError({ message }));

const tryIo = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CourseIngestError({ message: `${what}: ${String(cause)}` }),
  });

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const captionTime = (value: string): number => {
  const parts = value.replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
};

const cleanCaption = (value: string): string =>
  value
    .replace(/<\/?(?:c|v|i|lang|ruby|rt|b|u|em)(?:\s[^>]*)?>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const removeRollingDuplicate = (previous: string, current: string): string => {
  if (!previous) return current;
  if (current === previous || previous.startsWith(current)) return "";
  if (current.startsWith(previous)) return current.slice(previous.length).trim();
  const a = previous.split(" ");
  const b = current.split(" ");
  const limit = Math.min(a.length, b.length);
  for (let n = limit; n >= 2; n -= 1) {
    if (a.slice(-n).join(" ") === b.slice(0, n).join(" ")) return b.slice(n).join(" ");
  }
  return current;
};

interface CaptionCue {
  readonly start: number;
  readonly text: string;
}

const bucketCues = (cues: readonly CaptionCue[]): string => {
  const buckets = new Map<number, string[]>();
  let previous = "";
  for (const cue of cues) {
    const cleaned = cleanCaption(cue.text);
    if (!cleaned) continue;
    const novel = removeRollingDuplicate(previous, cleaned);
    previous = cleaned;
    if (!novel) continue;
    const bucket = Math.floor(cue.start / 30) * 30;
    const values = buckets.get(bucket) ?? [];
    values.push(novel);
    buckets.set(bucket, values);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seconds, values]) => `[${formatTimestamp(seconds)}] ${values.join(" ")}`)
    .join("\n");
};

const formatTimestamp = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/** Convert WebVTT or SRT into timestamped, 30-second buckets. */
export const captionToText = (raw: string): string => {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues: CaptionCue[] = [];
  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim());
    const timeIndex = lines.findIndex((line) =>
      /\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->/.test(line),
    );
    if (timeIndex < 0) continue;
    const match = lines[timeIndex]!.match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->/);
    if (!match) continue;
    const text = lines.slice(timeIndex + 1).join(" ");
    if (text) cues.push({ start: captionTime(match[1]!), text });
  }
  return bucketCues(cues);
};

/** Convert YouTube's json3 caption format into timestamped, 30-second buckets. */
export const json3ToText = (raw: string): string => {
  const parsed = asRecord(parseJson(raw));
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const cues: CaptionCue[] = [];
  for (const event of events) {
    const item = asRecord(event);
    const segs = Array.isArray(item.segs) ? item.segs : [];
    const text = segs.map((seg) => stringValue(asRecord(seg).utf8) ?? "").join(" ");
    const start = Number(item.tStartMs ?? 0) / 1000;
    if (text.trim()) cues.push({ start: Number.isFinite(start) ? start : 0, text });
  }
  return bucketCues(cues);
};

const parseVideoFiles = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") return asRecord(parseJson(value));
  return asRecord(value);
};

const resourceCaptionName = (resource: Record<string, unknown>): string | undefined => {
  const files = parseVideoFiles(resource.video_files);
  const captions = files.video_captions_resources;
  if (!Array.isArray(captions)) return undefined;
  for (const caption of captions) {
    const name = stringValue(asRecord(caption).file);
    if (name && /\.(?:vtt|srt)$/i.test(name)) return NodePath.basename(name);
  }
  return undefined;
};

const resourceYoutubeId = (resource: Record<string, unknown>): string | undefined => {
  const metadata = asRecord(resource.video_metadata);
  return stringValue(metadata.youtube_id) ?? stringValue(resource.youtube_id);
};

const licenseName = (license: string) => {
  const cc = license.match(/creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i);
  return cc ? `CC ${cc[1]!.toUpperCase()} ${cc[2]}` : license;
};

/** Parse the members of an already-unzipped OCW archive. Useful for callers and fixture tests. */
export const parseOcwZipEntries = (
  entries: ReadonlyMap<string, string | Uint8Array>,
  source: string,
): IngestedCourse => {
  const dataEntries = [...entries.entries()].filter(([name]) => /(?:^|\/)data\.json$/i.test(name));
  const records = dataEntries.map(([name, raw]) => ({
    name,
    record: asRecord(
      typeof raw === "string" ? parseJson(raw) : parseJson(Buffer.from(raw).toString("utf8")),
    ),
  }));
  const topRecord =
    records.toSorted((a, b) => a.name.split("/").length - b.name.split("/").length)[0]?.record ??
    {};
  const slug = source.match(/\/courses\/([^/]+)/)?.[1] ?? source;
  const courseTitle = stringValue(topRecord.course_title);
  const courseNumber = stringValue(topRecord.primary_course_number);
  const title = courseTitle
    ? [courseNumber, courseTitle].filter(Boolean).join(" ")
    : (stringValue(topRecord.title) ?? slug);
  // OCW's video gallery lists lectures in course order; resource folders are in arbitrary order.
  const galleryOrder = new Map<string, number>();
  for (const { name, record } of records) {
    if (!name.includes("video_galleries/") || !Array.isArray(record.videos)) continue;
    for (const video of record.videos) {
      const uid = stringValue(asRecord(video).uid);
      if (uid && !galleryOrder.has(uid)) galleryOrder.set(uid, galleryOrder.size);
    }
  }
  const order = (record: Record<string, unknown>) =>
    galleryOrder.get(stringValue(record.uid) ?? "") ?? Number.MAX_SAFE_INTEGER;
  const videos = records
    .filter(({ name }) => /(?:^|\/)resources\/[^/]+\/data\.json$/i.test(name))
    .filter(({ record }) => stringValue(record.resourcetype)?.toLowerCase() === "video")
    .toSorted((a, b) => order(a.record) - order(b.record));
  const units: IngestedUnit[] = [];
  let license: string | undefined;
  for (const { record } of videos) {
    const resourceTitle = stringValue(record.title) ?? "Untitled video";
    const resourceLicense = stringValue(record.license);
    license ??= resourceLicense;
    const captionName = resourceCaptionName(record);
    const caption = captionName
      ? (entries.get(`static_resources/${captionName}`) ??
        entries.get(captionName) ??
        [...entries.entries()].find(
          ([name]) =>
            name.endsWith(`/static_resources/${captionName}`) || name.endsWith(`/${captionName}`),
        )?.[1])
      : undefined;
    const captionText =
      caption === undefined
        ? undefined
        : captionToText(
            typeof caption === "string" ? caption : Buffer.from(caption).toString("utf8"),
          );
    const unit: IngestedUnit = { title: resourceTitle };
    const youtubeId = resourceYoutubeId(record);
    if (youtubeId) (unit as { youtubeId: string }).youtubeId = youtubeId;
    if (captionText) (unit as { text: string }).text = captionText;
    units.push(unit);
  }
  return {
    kind: "ocw",
    title,
    source,
    ...(license ? { license } : {}),
    attribution: `MIT OpenCourseWare, ${title}${license ? `, ${licenseName(license)}` : ""}`,
    units,
  };
};

const readStream = async (stream: NodeJS.ReadableStream): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
};

/** Parse an OCW zip using the repository's yauzl wrapper. */
export const parseOcwZip = (zipPath: string, source: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const archive = yield* openZipArchive(
        zipPath,
        (detail) => new CourseIngestError({ message: detail }),
      );
      const entries = new Map<string, Uint8Array>();
      while (true) {
        const entry = yield* archive.next;
        if (!entry) break;
        if (!/(?:^|\/)data\.json$|\.(?:vtt|srt)$/i.test(entry.fileName)) continue;
        const stream = yield* archive.streamEntry(entry);
        const bytes = yield* tryIo("Could not read the OCW zip", () => readStream(stream));
        entries.set(entry.fileName, bytes);
      }
      return parseOcwZipEntries(entries, source);
    }),
  );

const boundedDownload = (url: string, destination: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]),
      });
      if (!response.ok || !response.body)
        throw new Error(`Download failed with HTTP ${response.status}.`);
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_ZIP_BYTES)
        throw new Error("The OCW download is larger than the 300 MB limit.");
      const handle = await NodeFSP.open(destination, "w");
      let total = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_ZIP_BYTES)
            throw new Error("The OCW download is larger than the 300 MB limit.");
          await handle.write(value);
        }
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => new CourseIngestError({ message: String(cause) }),
  });

const ocwDownloadUrl = (source: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const fetchPage = (url: URL) =>
        fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      // Every URL we fetch stays on OCW: the source can come from a YouTube description.
      const onOcw = (url: URL) => {
        if (url.hostname !== "ocw.mit.edu" || !/^https?:$/.test(url.protocol))
          throw new Error(`${url.origin} is not MIT OpenCourseWare.`);
        return url;
      };
      let parsed = onOcw(new URL(source));
      // Short links such as ocw.mit.edu/18-06S05 redirect to /courses/<slug>/.
      if (!parsed.pathname.startsWith("/courses/")) {
        const landing = await fetchPage(parsed);
        await landing.body?.cancel();
        parsed = onOcw(new URL(landing.url));
      }
      const page = new URL(parsed.origin);
      page.pathname = `${parsed.pathname.replace(/\/$/, "")}/download/`;
      const response = await fetchPage(page);
      if (!response.ok) throw new Error(`OCW download page returned HTTP ${response.status}.`);
      const html = await response.text();
      const match = html.match(/href=["']([^"']+\.zip(?:\?[^"']*)?)["']/i);
      if (!match) throw new Error("The OCW download page did not contain a course zip.");
      return onOcw(new URL(match[1]!, page)).toString();
    },
    catch: (cause) =>
      new CourseIngestError({
        message: `Could not find the OCW course download: ${String(cause)}`,
      }),
  });

const ingestOcw = Effect.fn("course.ingestOcw")(function* (source: string, workDir: string) {
  const zipUrl = yield* ocwDownloadUrl(source);
  const directory = yield* tryIo("Could not make a temp folder", async () => {
    await NodeFSP.mkdir(workDir, { recursive: true });
    return NodeFSP.mkdtemp(NodePath.join(workDir, "ocw-"));
  });
  const zipPath = NodePath.join(directory, "course.zip");
  return yield* boundedDownload(zipUrl, zipPath).pipe(
    Effect.andThen(parseOcwZip(zipPath, source)),
    Effect.ensuring(
      Effect.promise(() =>
        NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined),
      ),
    ),
  );
});

const runYtDlp = Effect.fn("course.runYtDlp")(function* (args: ReadonlyArray<string>) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({ command: "yt-dlp", args, timeout: "120 seconds", outputMode: "truncate" })
    .pipe(
      Effect.mapError(
        (cause) => new CourseIngestError({ message: `yt-dlp failed: ${String(cause)}` }),
      ),
    );
  if (result.code !== 0) return yield* fail(`yt-dlp failed: ${result.stderr || result.stdout}`);
  return result.stdout;
});

const youtubeUnits = (source: string, listing: string): IngestedCourse => {
  const parsed = asRecord(parseJson(listing));
  const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [parsed];
  const units = rawEntries.map((entry, index) => {
    const item = asRecord(entry);
    const unit: IngestedUnit = { title: stringValue(item.title) ?? `Video ${index + 1}` };
    const id = stringValue(item.id);
    if (id) (unit as { youtubeId: string }).youtubeId = id;
    return unit;
  });
  const title = stringValue(parsed.title) ?? units[0]?.title ?? "YouTube course";
  return { kind: "youtube", title, source, units };
};

const ingestYoutube = Effect.fn("course.ingestYoutube")(function* (
  source: string,
  options: IngestOptions,
) {
  if (!options.ytDlp) {
    return yield* fail(
      "Fetching YouTube captions is off. Call course_add with a title and the lecture names as units, then ask the learner to paste each transcript from YouTube's Show transcript panel and save it with course_update (unit and transcript). The learner can also turn fetching on in Settings → Threads → Courses.",
    );
  }
  const listing = yield* runYtDlp(["--flat-playlist", "-J", "--", source]);
  const metadata = asRecord(parseJson(listing));
  const description = stringValue(metadata.description) ?? "";
  const ocw = description.match(/https?:\/\/ocw\.mit\.edu\/(?:courses\/[^\s)]+|[^\s)]+)/i)?.[0];
  const units = youtubeUnits(source, listing);
  if (!ocw) return units;
  return yield* ingestOcw(ocw.replace(/[.,]+$/, ""), options.workDir).pipe(
    Effect.catch((error) =>
      Effect.logWarning("OCW course download failed; using the YouTube units", error).pipe(
        Effect.as(units),
      ),
    ),
  );
});

const extractPdf = Effect.fn("course.extractPdf")(function* (source: string) {
  const pdfjs = yield* Effect.tryPromise({
    try: async () => {
      // The server bundle has no pdf.worker.mjs beside pdf.mjs; importing it sets globalThis.pdfjsWorker.
      // @ts-expect-error pdfjs-dist ships no types for its worker module.
      await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      return import("pdfjs-dist/legacy/build/pdf.mjs");
    },
    catch: (cause) =>
      new CourseIngestError({ message: `Could not load the PDF reader: ${String(cause)}` }),
  });
  const bytes = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(source),
    catch: (cause) =>
      new CourseIngestError({ message: `Could not read the PDF: ${String(cause)}` }),
  });
  const document = yield* Effect.tryPromise({
    try: () => pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise,
    catch: (cause) =>
      new CourseIngestError({ message: `Could not open the PDF: ${String(cause)}` }),
  });
  const metadata = yield* tryIo("PDF metadata", () => document.getMetadata()).pipe(
    Effect.orElseSucceed(() => ({ info: {} })),
  );
  const title =
    stringValue(asRecord(metadata.info).Title) ??
    NodePath.basename(source, NodePath.extname(source));
  const outline = yield* tryIo("PDF outline", () => document.getOutline()).pipe(
    Effect.orElseSucceed(() => null),
  );
  const pageText = new Map<number, string>();
  let extracted = 0;
  const getPageText = (pageNumber: number) =>
    Effect.tryPromise({
      try: async () => {
        if (pageText.has(pageNumber)) return pageText.get(pageNumber) ?? "";
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const clipped = text.slice(0, Math.max(0, MAX_PDF_TEXT - extracted));
        extracted += clipped.length;
        pageText.set(pageNumber, clipped);
        return clipped;
      },
      catch: (cause) =>
        new CourseIngestError({
          message: `Could not extract PDF page ${pageNumber}: ${String(cause)}`,
        }),
    });
  const pageCount = document.numPages;
  const starts: Array<{ title: string; page: number }> = [];
  for (const item of Array.isArray(outline) ? outline : []) {
    const record = asRecord(item);
    const destination =
      typeof record.dest === "string"
        ? yield* tryIo("PDF outline", () => document.getDestination(record.dest as string)).pipe(
            Effect.orElseSucceed(() => null),
          )
        : record.dest;
    const reference = Array.isArray(destination) ? destination[0] : undefined;
    if (!reference) continue;
    const page =
      (yield* tryIo("PDF outline", () => document.getPageIndex(reference)).pipe(
        Effect.orElseSucceed(() => -1),
      )) + 1;
    if (page < 1) continue;
    starts.push({ title: stringValue(record.title) ?? "Untitled", page });
  }
  const ranges = starts.length
    ? starts.map((entry, index) => ({
        title: entry.title,
        from: entry.page,
        to: Math.max(entry.page, (starts[index + 1]?.page ?? pageCount) - 1),
      }))
    : Array.from({ length: Math.ceil(pageCount / 20) }, (_, index) => ({
        from: index * 20 + 1,
        to: Math.min(pageCount, (index + 1) * 20),
        title: `Pages ${index * 20 + 1}–${Math.min(pageCount, (index + 1) * 20)}`,
      }));
  const units: IngestedUnit[] = [];
  for (const range of ranges) {
    const parts: string[] = [];
    for (let page = range.from; page <= range.to; page += 1) parts.push(yield* getPageText(page));
    units.push({ title: range.title, pages: [range.from, range.to], text: parts.join("\n\n") });
  }
  return { kind: "pdf", title, source, units } satisfies IngestedCourse;
});

const parseSource = (
  source: string,
): { type: "ocw" | "youtube" | "pdf"; url?: URL } | CourseIngestError => {
  if (NodePath.isAbsolute(source) && source.toLowerCase().endsWith(".pdf")) return { type: "pdf" };
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return new CourseIngestError({
      message:
        "Supported sources are an OCW URL, a YouTube video or playlist URL, or an existing absolute .pdf path.",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return new CourseIngestError({
      message:
        "Supported sources are http(s) OCW or YouTube URLs, or an existing absolute .pdf path.",
    });
  if (url.hostname === "ocw.mit.edu" && /\/courses\/[^/]+/.test(url.pathname))
    return { type: "ocw", url };
  if (YOUTUBE_HOSTS.has(url.hostname)) return { type: "youtube", url };
  return new CourseIngestError({
    message:
      "Supported sources are http(s) URLs to ocw.mit.edu or YouTube, or an existing absolute .pdf path.",
  });
};

export const ingestCourse = (
  source: string,
  options: IngestOptions,
): Effect.Effect<IngestedCourse, CourseIngestError, ProcessRunner.ProcessRunner> => {
  const parsed = parseSource(source);
  if (isCourseIngestError(parsed)) return Effect.fail(parsed);
  if (parsed.type === "pdf") {
    return tryIo("Could not access the PDF", () => NodeFSP.stat(source)).pipe(
      Effect.flatMap((stat) =>
        stat.isFile() ? extractPdf(source) : fail("The PDF path does not point to a file."),
      ),
    );
  }
  return parsed.type === "ocw"
    ? ingestOcw(source, options.workDir)
    : ingestYoutube(source, options);
};

/** Captions for one YouTube video as `[mm:ss] text` lines. */
export const fetchYoutubeTranscript = Effect.fn("course.fetchYoutubeTranscript")(function* (
  youtubeId: string,
) {
  const directory = yield* tryIo("Could not make a temp folder", () =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-course-")),
  );
  return yield* Effect.gen(function* () {
    const output = NodePath.join(directory, "%(id)s.%(ext)s");
    yield* runYtDlp([
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "en,en-orig",
      "--sub-format",
      "json3",
      "--sleep-requests",
      "1",
      "--output",
      output,
      "--",
      `https://www.youtube.com/watch?v=${youtubeId}`,
    ]);
    const files = yield* tryIo("Could not read captions", () => NodeFSP.readdir(directory));
    const caption = files
      .filter((file) => file.endsWith(".json3"))
      .sort((a, b) => (a.includes(".en.") ? -1 : 0) - (b.includes(".en.") ? -1 : 0))[0];
    if (!caption) return yield* fail("yt-dlp did not produce an English transcript.");
    return json3ToText(
      yield* tryIo("Could not read captions", () =>
        NodeFSP.readFile(NodePath.join(directory, caption), "utf8"),
      ),
    );
  }).pipe(
    Effect.ensuring(
      Effect.promise(() =>
        NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined),
      ),
    ),
  );
});

export const transcriptWindow = (
  text: string,
  atSeconds: number,
  radiusSeconds: number,
): string => {
  if (!/^\[\d{1,2}:\d{2}(?::\d{2})?\]/m.test(text)) return text;
  return text
    .split("\n")
    .filter((line) => {
      const match = line.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
      if (!match) return false;
      return Math.abs(captionTime(match[1]!) - atSeconds) <= radiusSeconds;
    })
    .join("\n");
};
