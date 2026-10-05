import type { ThreadId } from "@t3tools/contracts";
import { HostProcessUserId } from "@t3tools/shared/hostProcess";
import {
  clampHtmlRenderHeight,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MEASURE_FONTS,
  HTML_RENDER_MEASURE_WIDTHS,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  type ThemeAppearance,
} from "@t3tools/shared/themePalettes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as HeadlessChrome from "./headlessChrome.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * MIB;
const MAX_PAGE_BYTES = 25 * MIB;
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

export class HtmlRenderImagesNotFoundError extends Schema.TaggedError<HtmlRenderImagesNotFoundError>()(
  "HtmlRenderImagesNotFoundError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `These local images could not be read: ${this.paths.join(", ")}. Use absolute paths to existing image files, or remove them.`;
  }
}

export class HtmlRenderImageTooLargeError extends Schema.TaggedError<HtmlRenderImageTooLargeError>()(
  "HtmlRenderImageTooLargeError",
  { path: Schema.String, sizeBytes: Schema.Number },
) {
  override get message(): string {
    return `${this.path} is ${formatMib(this.sizeBytes)}; each local image must be at most ${formatMib(MAX_IMAGE_BYTES)}.`;
  }
}

export class HtmlRenderPageTooLargeError extends Schema.TaggedError<HtmlRenderPageTooLargeError>()(
  "HtmlRenderPageTooLargeError",
  { sizeBytes: Schema.Number },
) {
  override get message(): string {
    return `With its images inlined the page is ${formatMib(this.sizeBytes)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.`;
  }
}

export class HtmlRenderStoreError extends Schema.TaggedError<HtmlRenderStoreError>()(
  "HtmlRenderStoreError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The HTML render could not be saved.";
  }
}

export type HtmlRenderPrepareError =
  | HtmlRenderImagesNotFoundError
  | HtmlRenderImageTooLargeError
  | HtmlRenderPageTooLargeError;

export interface HtmlPreview {
  /** Base64 PNG of the top `capturedHeight` pixels. */
  readonly png: string;
  readonly width: number;
  /** Height the page needs to show without scrolling. */
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: ReadonlyArray<HeadlessChrome.ConsoleMessage>;
  /** Local image paths that could not be read; they show as broken images. */
  readonly missingImages?: ReadonlyArray<string>;
}

export class HtmlRender extends Context.Service<
  HtmlRender,
  {
    /** The self-contained page that gets stored: local images inlined, theme bootstrap injected. */
    readonly prepare: (html: string) => Effect.Effect<string, HtmlRenderPrepareError>;
    /**
     * Stores a prepared page as a thread attachment for clients to show inline,
     * measuring its height at each client width when the preview browser is
     * already installed.
     */
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly html: string;
      readonly title: string;
      readonly height: number;
    }) => Effect.Effect<HtmlRenderReference, HtmlRenderPrepareError | HtmlRenderStoreError>;
    /** Screenshots a page in headless Chrome, tolerating unreadable local images. */
    readonly preview: (input: {
      readonly html: string;
      readonly width?: number | undefined;
      readonly appearance?: ThemeAppearance | undefined;
    }) => Effect.Effect<
      HtmlPreview,
      | Exclude<HtmlRenderPrepareError, HtmlRenderImagesNotFoundError>
      | PreviewBrowser.PreviewBrowserInstallError
      | PreviewBrowser.PreviewBrowserInstallingError
      | PreviewBrowser.PreviewBrowserUnsupportedError
      | HeadlessChrome.HtmlRenderBrowserError
    >;
  }
>()("t3/htmlRender/HtmlRender") {}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
// POSIX `/…` (not protocol-relative `//…`) or Windows `C:\…` / `C:/…`.
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
// An absolute image path that is a whole quoted string ("…", '…', `…`) or an
// unquoted CSS url(…). URLs, data:, blob:, and relative paths never match.
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);

const findLocalImages = (html: string) =>
  Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
  });

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const dataUriPrefix = (path: string) =>
  `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * Whether file bytes are an image, whatever the file is named, so a symlink or
 * renamed file cannot carry other data, such as a secret, into a page.
 */
const isImageBytes = (bytes: Uint8Array) => {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  // An SVG's root element is <svg>, after an optional XML declaration, comments, and doctype.
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!doctype[^>]*>)\s*)*<svg[\s/>]/i.test(
    new TextDecoder().decode(bytes.subarray(0, 4096)),
  );
};

/** Replaces every local image reference with a data URI; unreadable paths stay as written. */
const inlineLocalImages = Effect.fn("HtmlRender.inlineLocalImages")(function* (html: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const references = findLocalImages(html);
  const files = yield* Effect.forEach(
    [...new Set(references.map((reference) => reference.path))],
    (path) =>
      fileSystem.stat(filePathFor(path)).pipe(
        Effect.map((info) => ({
          path,
          size: info.type === "File" ? Number(info.size) : undefined,
        })),
        Effect.orElseSucceed(() => ({ path, size: undefined })),
      ),
    { concurrency: 8 },
  );
  const oversized = files.find((file) => file.size !== undefined && file.size > MAX_IMAGE_BYTES);
  if (oversized?.size !== undefined) {
    return yield* new HtmlRenderImageTooLargeError({
      path: oversized.path,
      sizeBytes: oversized.size,
    });
  }
  const sizes = new Map(files.map((file) => [file.path, file.size]));
  const pageBytes = references.reduce((total, reference) => {
    const size = sizes.get(reference.path);
    return size === undefined
      ? total
      : total +
          dataUriPrefix(reference.path).length +
          Math.ceil(size / 3) * 4 -
          Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (pageBytes > MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({ sizeBytes: pageBytes });
  }
  // Reads stop one byte past the limit, so a file that grew after `stat` is caught.
  const images = yield* Effect.forEach(
    files.filter((file) => file.size !== undefined),
    (file) =>
      fileSystem.stream(filePathFor(file.path), { bytesToRead: MAX_IMAGE_BYTES + 1 }).pipe(
        Stream.mkUint8Array,
        Effect.map((bytes) => (isImageBytes(bytes) ? [{ path: file.path, bytes }] : [])),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((entries) => entries.flat()));
  const grown = images.find((image) => image.bytes.byteLength > MAX_IMAGE_BYTES);
  if (grown !== undefined) {
    return yield* new HtmlRenderImageTooLargeError({
      path: grown.path,
      sizeBytes: grown.bytes.byteLength,
    });
  }
  const dataUris = new Map(
    images.map(
      (image) =>
        [image.path, dataUriPrefix(image.path) + Encoding.encodeBase64(image.bytes)] as const,
    ),
  );
  const parts: Array<string> = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  const inlined = parts.join("");
  const inlinedBytes = Buffer.byteLength(inlined);
  if (inlinedBytes > MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({ sizeBytes: inlinedBytes });
  }
  return {
    html: inlined,
    missing: files.filter((file) => !dataUris.has(file.path)).map((file) => file.path),
  };
});

const MIN_PREVIEW_WIDTH = 240;
const MAX_PREVIEW_WIDTH = 1_600;
// Each preview or measurement runs its own browser; more at once mostly costs memory.
const MAX_CONCURRENT_BROWSERS = 2;
// Publishing waits this long at most for heights before returning without them.
const MEASURE_TIMEOUT = "6 seconds";

// Measured in the dark theme with Arial-metric fonts, so text wraps close to how clients show it.
const MEASURE_FRAGMENT = htmlRenderThemeFragment(
  htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_MEASURE_FONTS),
);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const browsers = yield* Semaphore.make(MAX_CONCURRENT_BROWSERS);
  // Chrome refuses its sandbox as root. Other hosts that cannot provide one
  // (Ubuntu 23.10+ AppArmor) are learned from the first launch and remembered.
  let noSandbox = (yield* HostProcessUserId) === 0;

  const launching = <A>(
    run: (
      noSandbox: boolean,
    ) => Effect.Effect<
      A,
      HeadlessChrome.HtmlRenderBrowserError | HeadlessChrome.HtmlRenderSandboxUnavailableError
    >,
  ) =>
    browsers.withPermits(1)(
      // Read once a permit is held, so a queued call sees a fallback learned meanwhile.
      Effect.suspend(() => run(noSandbox)).pipe(
        Effect.catchTag("HtmlRenderSandboxUnavailableError", () =>
          Effect.logInfo(
            "Chrome's sandbox is unavailable on this host; launching it without one.",
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                noSandbox = true;
              }),
            ),
            Effect.andThen(run(true)),
          ),
        ),
        Effect.catchTag("HtmlRenderSandboxUnavailableError", (cause) =>
          Effect.fail(
            new HeadlessChrome.HtmlRenderBrowserError({
              reason: "the browser has no sandbox",
              cause,
            }),
          ),
        ),
      ),
    );

  // Never installs the browser: html_render must not depend on it.
  const measure = (html: string) =>
    Effect.gen(function* () {
      const executable = yield* previewBrowser.installed;
      if (Option.isNone(executable)) return undefined;
      const heights = yield* launching((noSandbox) =>
        HeadlessChrome.measureHtmlHeights({
          executable: executable.value,
          noSandbox,
          html,
          widths: HTML_RENDER_MEASURE_WIDTHS,
          urlFragment: MEASURE_FRAGMENT,
        }).pipe(Effect.provideContext(services)),
      ).pipe(
        Effect.timeoutOrElse({
          duration: MEASURE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new HeadlessChrome.HtmlRenderBrowserError({
                reason: `measuring took longer than ${MEASURE_TIMEOUT}`,
              }),
            ),
        }),
      );
      return heights.toSorted(([left], [right]) => left - right);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not measure an HTML render; publishing it without heights.", {
          cause,
        }).pipe(Effect.as(undefined)),
      ),
      Effect.withSpan("HtmlRender.measure"),
    );

  // The bootstrap goes in first so its head scan never runs over inlined image data.
  const inline = (html: string) =>
    inlineLocalImages(injectHtmlRenderBootstrap(html)).pipe(Effect.provideContext(services));

  const prepare = Effect.fn("HtmlRender.prepare")(function* (html: string) {
    const inlined = yield* inline(html);
    if (inlined.missing.length > 0) {
      return yield* new HtmlRenderImagesNotFoundError({ paths: inlined.missing });
    }
    return inlined.html;
  });

  const publish = Effect.fn("HtmlRender.publish")(function* (input: {
    readonly threadId: ThreadId;
    readonly html: string;
    readonly title: string;
    readonly height: number;
  }) {
    const html = yield* prepare(input.html);
    // The `-html` id suffix makes the asset route serve it as a sandboxed text/html document.
    const attachmentId = createAttachmentId(input.threadId, "html");
    const filePath =
      attachmentId === null
        ? null
        : resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: `${attachmentId}.html`,
          });
    if (attachmentId === null || filePath === null) {
      return yield* new HtmlRenderStoreError({ cause: new Error("Invalid thread id.") });
    }
    const heights = yield* fileSystem.writeFileString(filePath, html).pipe(
      Effect.mapError((cause) => new HtmlRenderStoreError({ cause })),
      Effect.andThen(measure(html)),
      // Only the returned reference lets thread deletion find the page, so a
      // publish that fails or is interrupted before returning removes it.
      Effect.onError(() => fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore)),
    );
    return {
      attachmentId,
      title: input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
      height: clampHtmlRenderHeight(input.height),
      ...(heights === undefined ? {} : { heights }),
    } satisfies HtmlRenderReference;
  });

  const preview = Effect.fn("HtmlRender.preview")(function* (input: {
    readonly html: string;
    readonly width?: number | undefined;
    readonly appearance?: ThemeAppearance | undefined;
  }) {
    const width = Math.min(
      MAX_PREVIEW_WIDTH,
      Math.max(MIN_PREVIEW_WIDTH, Math.round(input.width ?? HTML_RENDER_COLUMN_WIDTH)),
    );
    const appearance = input.appearance ?? "dark";
    const inlined = yield* inline(input.html);
    const executable = yield* previewBrowser.executable;
    const theme = htmlRenderTheme(
      appearance === "light" ? T3_CODE_LIGHT_THEME_COLORS : T3_CODE_DARK_THEME_COLORS,
      appearance,
      HTML_RENDER_MEASURE_FONTS,
    );
    const screenshot = yield* launching((noSandbox) =>
      HeadlessChrome.captureHtmlScreenshot({
        executable,
        noSandbox,
        html: inlined.html,
        width,
        urlFragment: htmlRenderThemeFragment(theme),
      }).pipe(Effect.provideContext(services)),
    );
    return {
      ...screenshot,
      width,
      ...(inlined.missing.length === 0 ? {} : { missingImages: inlined.missing }),
    } satisfies HtmlPreview;
  });

  return HtmlRender.of({ prepare, publish, preview });
});

export const layer = Layer.effect(HtmlRender, make);
