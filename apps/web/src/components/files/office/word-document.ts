// Adapted from opencode (MIT). Copyright (c) 2025 opencode. See LICENSE.opencode.
import * as Schema from "effect/Schema";
import {
  buildResidentRegionLayoutRequest,
  getLayoutKernelInputs,
  workerLayoutComputation,
} from "@betteroffice/docx/editor";
import { createRustMeasureSource } from "@betteroffice/docx/layout";
import {
  applyFrameDelta,
  decodeFrameDelta,
  encodeDisplayListFrameExtras,
  GlyphCache,
  rasterizeDisplayPageToBackBuffer,
  type DisplayPage,
  type RetainedFrame,
} from "@betteroffice/docx/layout/render";
import {
  createYrsPositionProjection,
  createYrsSession,
  type YrsPositionProjection,
} from "@betteroffice/docx/yrs";
import { loadFace, sheetFace, wordFonts } from "./fonts";
import { maxImageSide, type VectorBitmap } from "./vector-pictures";
import { withWholeMissingGlyphs } from "./word-glyphs";
import { createBitmapImageResolver } from "./word-images";
import { layerFont, type WordPageSize, type WordSpan } from "./word-protocol";
import { pageText, positionTarget, type TextMeasure } from "./word-text";

// An open Word document: its engine session, fonts, layout, built pages and painting. The document worker holds one.

const FontRequirements = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      key: Schema.String,
      family: Schema.String,
      bold: Schema.Boolean,
      italic: Schema.Boolean,
      scripts: Schema.optional(
        Schema.Array(Schema.Literals(["cjk-sc", "cjk-tc", "cjk-jp", "cjk-kr", "arabic", "hebrew"])),
      ),
    }),
  ),
);

const decodeFontRequirements = Schema.decodeUnknownSync(FontRequirements);

/** A prefix layout's reply marks itself provisional when the document goes on past it. */
const decodeLayoutReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ provisional: Schema.optional(Schema.Boolean) })),
);

/** Pages laid out and built before the first paint; later pages are built as they near the viewport. */
const firstPages = 3;

/** How long one layout step may hold back a paint that waits behind it, in milliseconds. */
const stepBudget = 24;

/**
 * How many pages either side of the page painted last stay built. A built page holds about 5 MB in the engine and
 * builds again in about 100 ms. This keeps every page near the viewport, which paints a viewport ahead in both
 * directions, and lets a reader scroll back a few screens without waiting, while a long read holds at most 21 pages.
 */
const keptAround = 10;

/** A value built on first use. */
type Lazy<T> = { value: T | undefined };

/**
 * Opens the document and lays out its first pages; the rest lay out a `step` at a time. `fonts` is the font set the
 * painting canvas draws text with, if it has one.
 */
export async function openWordDocument(bytes: Uint8Array, fonts: FontFaceSet | undefined) {
  const session = await createYrsSession();
  const document = session.openDocx(bytes, true, { mediaTokens: true }).document;
  const settings = document.package.settings;

  const measure = createRustMeasureSource({
    engine: {
      registerFont: (font) => session.registerFont(font),
      registerSubstituteFont: (id, family) => session.registerSubstituteFont(id, family),
      clearFonts: () => session.clearFonts(),
    },
    bundled: wordFonts(),
  });

  measure.setCompat(settings?.compatibilityFlags);

  const request = buildResidentRegionLayoutRequest(document, 0, {
    themeColors: Object.fromEntries(
      Object.entries(document.package.theme?.colorScheme ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    defaultTabStopTwips: settings?.defaultTabStop ?? null,
    numericIds: {},
    mediaTokens: true,
  });

  const requirements = decodeFontRequirements(
    session.layoutFontRequirementsJson(JSON.stringify(request)),
  ).map(({ scripts, ...requirement }) => ({
    ...requirement,
    ...(scripts ? { scripts: [...scripts] } : {}),
  }));

  await Promise.all([
    measure.prepareFontRequirements(requirements),
    fonts && addCanvasFaces(fonts, requirements),
  ]);

  const measurement = measure.measurementConfigForRequirements(requirements);

  if (!measurement) throw new Error("The document's fonts could not be prepared");

  const input = JSON.stringify({ ...request, measurement });

  // Word shows resolved comments without the active highlight.
  const resolvedCommentIds = (document.package.document.comments ?? [])
    .filter(
      (comment) =>
        (comment.done || comment.status === "resolved") && comment.parentId === undefined,
    )
    .map((comment) => comment.id);

  // The session keeps the layout it last ran and builds display frames from it: only the display extras go in, and a
  // binary frame comes back with the window's pages built and every other page a placeholder carrying its geometry.
  const display = (previous: RetainedFrame | null, reply: string) => {
    const layout = workerLayoutComputation(reply).layout;

    session.setDisplayWindow(0, firstPages);

    const extras = encodeDisplayListFrameExtras({
      measured: [],
      options: {},
      layout,
      fontChains: measurement.fontChains,
      ...(getLayoutKernelInputs(layout)?.headersFooters
        ? { headersFooters: getLayoutKernelInputs(layout)!.headersFooters! }
        : {}),
      resolvedCommentIds,
    });

    return applyFrameDelta(
      previous,
      decodeFrameDelta(session.buildDisplayListFrame(extras, previous?.frameEpoch ?? 0)),
    );
  };

  // Only as much of the body as fills the first pages; a long document goes on past it.
  const prefix = session.layoutDocumentWithRegionsPrefixRetainedJson(input, firstPages);
  const retained = { frame: display(null, prefix) };

  if (retained.frame.displayList.pages.length === 0)
    throw new Error("The document produced no pages");

  // The region layout that finishes the document: begun on the first step, `cost` the running average milliseconds a
  // body block takes.
  const layout = { loading: decodeLayoutReply(prefix).provisional ?? false, begun: false, cost: 3 };

  // Builds a page's content when it is needed and not built, the first time or again after `release`.
  const built = (index: number) => {
    const page = retained.frame.displayList.pages[index];

    if (!page?.unbuilt) return page;

    retained.frame = applyFrameDelta(
      retained.frame,
      decodeFrameDelta(session.buildDisplayPagesFrame([index], retained.frame.frameEpoch)),
    );

    return retained.frame.displayList.pages[index];
  };

  // Gives back the built pages far from the page about to paint, so a long read keeps only the pages around the
  // viewport. A released page keeps its geometry and document positions, which bookmarks search, and builds again
  // when it is needed.
  const release = (painted: number) => {
    // The engine releases pages of the whole document's layout only, and few pages show before it.
    if (layout.loading) return;

    const far = retained.frame.displayList.pages.flatMap((page, index) =>
      !page.unbuilt && Math.abs(painted - index) > keptAround ? [index] : [],
    );

    if (far.length === 0) return;

    const frame = session.releaseDisplayPagesFrame(far, retained.frame.frameEpoch);

    // A superseded release changes nothing; the next one tries again.
    if (frame) retained.frame = applyFrameDelta(retained.frame, decodeFrameDelta(frame));
  };

  // The whole document's layout replaces the prefix's frame.
  const complete = (reply: string) => {
    const before = retained.frame.displayList.pages;

    retained.frame = display(retained.frame, reply);
    layout.loading = false;

    const pages = retained.frame.displayList.pages;

    return {
      done: true as const,
      pages: pages.map(pageSize),
      kept: pages.map((page, index) => {
        const was = before[index];

        return was === page || (!!was?.unbuilt && !!page.unbuilt);
      }),
    };
  };

  const glyphCache = new GlyphCache({
    // The engine sets glyphs no bundled face has, such as Thai ones or emoji, as missing glyphs, which outline as empty
    // boxes. A run whose outlines fail paints whole with the canvas's fonts instead, which the system's cover.
    provider: (font, glyph) => {
      if (glyph === 0) throw new Error("No bundled face has this glyph");

      return session.outlineGlyphJson(font, glyph);
    },
  });
  const images = createBitmapImageResolver((token) => session.mediaSource(token));
  const surface = new OffscreenCanvas(1, 1);
  const fitting = new OffscreenCanvas(1, 1).getContext("2d");
  const painted = new WeakMap<DisplayPage, DisplayPage>();
  const textMeasure = layerMeasure();
  const texts = new WeakMap<DisplayPage, readonly WordSpan[]>();
  // Built on the first followed bookmark: most documents are read without one.
  const projection: Lazy<YrsPositionProjection | null> = { value: undefined };

  return {
    pages: () => retained.frame.displayList.pages,
    loading: () => layout.loading,
    built,
    /**
     * Lays out about `stepBudget` milliseconds more of the body. Blocks vary widely, and sizing a step by the last one
     * alone overshoots after a run of cheap blocks.
     */
    step: () => {
      if (!layout.loading) {
        const pages = retained.frame.displayList.pages;

        return { done: true as const, pages: pages.map(pageSize), kept: pages.map(() => true) };
      }

      if (!layout.begun) {
        layout.begun = true;

        const begun = session.beginRegionLayout(input);

        return begun.layoutJson === undefined
          ? { done: false as const }
          : complete(begun.layoutJson);
      }

      const blocks = Math.min(8192, Math.max(1, Math.round(stepBudget / layout.cost)));
      const started = performance.now();
      const progress = session.resumeRegionLayout(blocks);

      layout.cost = layout.cost * 0.7 + ((performance.now() - started) / blocks) * 0.3;

      return progress.layoutJson === undefined
        ? { done: false as const }
        : complete(progress.layoutJson);
    },
    paint: async (index: number, scale: number, ratio: number, signal: AbortSignal) => {
      // A page that scrolled away before its paint began, or while it rasterized, needs no bitmap.
      if (signal.aborted) return undefined;

      // Released first, so the page builds in the memory they free.
      release(index);

      const page = built(index);

      if (!page) return undefined;

      const paintable =
        painted.get(page) ?? (fitting ? withWholeMissingGlyphs(page, fitting) : page);

      painted.set(page, paintable);

      // The window drew image elements, which shrink smoothly at the default quality; a bitmap needs medium quality to
      // look the same. Sizing the surface first keeps the setting: the painter resizes it, which resets the context,
      // only when its size differs.
      const context = surface.getContext("2d");
      const width = Math.ceil(page.width * ratio * scale);
      const height = Math.ceil(page.height * ratio * scale);

      if (surface.width !== width) surface.width = width;

      if (surface.height !== height) surface.height = height;

      if (context) context.imageSmoothingQuality = "medium";

      await rasterizeDisplayPageToBackBuffer(
        surface,
        paintable,
        { glyphCache, resolveImage: images.resolve },
        ratio,
        scale,
      );

      const vectors = images.vectors(pictureSizes(paintable, ratio * scale));

      images.trim();

      if (signal.aborted) return undefined;

      return { bitmap: surface.transferToImageBitmap(), vectors };
    },
    vectors: (bitmaps: readonly VectorBitmap[]) => images.provide(bitmaps),
    text: (index: number) => {
      const page = built(index);

      if (!page || !textMeasure) return [];

      const cached = texts.get(page);

      if (cached) return cached;

      const spans = pageText(page, textMeasure);

      texts.set(page, spans);

      return spans;
    },
    target: (name: string) => {
      projection.value ??= createYrsPositionProjection(session, "body");

      const position = projection.value?.bookmarkPosition(name) ?? undefined;

      if (position !== undefined)
        return positionTarget(retained.frame.displayList.pages, position, built);

      // Word's reserved bookmark for the start of the document.
      return name === "_top" ? { index: 0, y: 0 } : undefined;
    },
  };
}

/**
 * The canvas draws list numbers, and runs no bundled face has glyphs for, with its own fonts, by their Word family.
 * Adding the document's faces under those names draws them like the rest of its text. A family the app ships no face
 * for stays with the system's, and CJK faces, tens of megabytes each, are not held twice.
 */
async function addCanvasFaces(
  fonts: FontFaceSet,
  requirements: readonly { family: string; bold: boolean; italic: boolean }[],
) {
  const faces = new Map<string, Promise<FontFace>>();

  for (const { family, bold, italic } of requirements) {
    const face = sheetFace(family, bold, italic);

    if (!face || face.script?.startsWith("cjk-")) continue;

    const key = `${family}\u0000${face.weight}\u0000${face.style}`;

    if (faces.has(key)) continue;

    // A family without the requested style gets the face it has, which the browser then slants or emboldens.
    faces.set(
      key,
      loadFace(face).then((source) =>
        new FontFace(family, source, {
          weight: face.weight === 700 ? "700" : "400",
          style: face.style === "italic" ? "italic" : "normal",
        }).load(),
      ),
    );
  }

  await Promise.all(
    [...faces.values()].map((face) =>
      face.then((loaded) => void fonts.add(loaded)).catch(() => undefined),
    ),
  );
}

/** Each picture's drawn size on a page in device pixels at `density`, up to `maxImageSide`. */
function pictureSizes(page: DisplayPage, density: number) {
  const sizes = new Map<string, { width: number; height: number }>();
  const primitives = [
    ...page.primitives,
    ...(page.header?.primitives ?? []),
    ...(page.footer?.primitives ?? []),
    ...(page.noteAreas ?? []).flatMap((area) => area.primitives ?? []),
  ];

  for (const primitive of primitives) {
    if (primitive.kind !== "image") continue;

    const width = (primitive.contentFrame?.w ?? primitive.w) * density;
    const height = (primitive.contentFrame?.h ?? primitive.h) * density;
    const shrink = Math.min(1, maxImageSide / Math.max(width, height));
    const previous = sizes.get(primitive.relId);

    sizes.set(primitive.relId, {
      width: Math.max(previous?.width ?? 1, Math.round(width * shrink)),
      height: Math.max(previous?.height ?? 1, Math.round(height * shrink)),
    });
  }

  return sizes;
}

export function pageSize(page: DisplayPage): WordPageSize {
  return { width: page.width, height: page.height, background: page.background };
}

/** Measures the text layer's font with a detached canvas; undefined where the worker offers no 2D context. */
function layerMeasure(): TextMeasure | undefined {
  const context = new OffscreenCanvas(1, 1).getContext("2d");

  if (!context) return undefined;

  // Measured large and scaled down, so rounding stays well below a pixel at any zoom.
  const size = 100;

  context.font = `${size}px ${layerFont}`;

  const metrics = context.measureText("Hg");

  return {
    width: (text) => context.measureText(text).width / size,
    ascent: metrics.fontBoundingBoxAscent / size,
    descent: metrics.fontBoundingBoxDescent / size,
  };
}
