import type {
  DisplayPage,
  DisplayPrimitive,
  GlyphRunPrimitive,
} from "@betteroffice/docx/layout/render";

/**
 * The page as the canvas paints it. The engine sets each glyph no bundled face has, such as Thai or Devanagari ones and
 * emoji, as a run of its own, which the canvas draws with the system's fonts. Neighbouring runs join here, so the
 * canvas shapes their text whole and marks join their letters. A run wider than the room the engine left it shrinks
 * into that room, rather than over the text after it.
 */
export function withWholeMissingGlyphs(
  page: DisplayPage,
  measure: OffscreenCanvasRenderingContext2D,
): DisplayPage {
  const regions = [
    page.primitives,
    page.header?.primitives,
    page.footer?.primitives,
    ...(page.noteAreas ?? []).map((area) => area.primitives),
  ];

  if (!regions.some((primitives) => primitives?.some(missing))) return page;

  const join = (primitives: readonly DisplayPrimitive[]) =>
    primitives
      .reduce<DisplayPrimitive[]>((joined, primitive) => {
        const previous = joined.at(-1);

        if (missing(previous) && missing(primitive) && continues(previous, primitive))
          joined[joined.length - 1] = {
            ...previous,
            text: previous.text + primitive.text,
            glyphs: [...previous.glyphs, ...shifted(primitive.glyphs, previous.text)],
            ...(primitive.docEnd === undefined ? {} : { docEnd: primitive.docEnd }),
          };
        else joined.push(primitive);

        return joined;
      }, [])
      .map((primitive) => (missing(primitive) ? fitted(primitive, measure) : primitive));

  // Watermark primitives lead the body and count apart, so they join apart.
  const marks = join(page.primitives.slice(0, page.watermarkPrimitiveCount ?? 0));

  return {
    ...page,
    primitives: [...marks, ...join(page.primitives.slice(page.watermarkPrimitiveCount ?? 0))],
    ...(page.watermarkPrimitiveCount === undefined
      ? {}
      : { watermarkPrimitiveCount: marks.length }),
    ...(page.header
      ? { header: { ...page.header, primitives: join(page.header.primitives) } }
      : {}),
    ...(page.footer
      ? { footer: { ...page.footer, primitives: join(page.footer.primitives) } }
      : {}),
    ...(page.noteAreas
      ? {
          noteAreas: page.noteAreas.map((area) =>
            area.primitives ? { ...area, primitives: join(area.primitives) } : area,
          ),
        }
      : {}),
  };
}

function missing(primitive: DisplayPrimitive | undefined): primitive is GlyphRunPrimitive {
  return (
    primitive?.kind === "glyphRun" && !primitive.rtl && primitive.glyphs.some((glyph) => !glyph.id)
  );
}

/** Neighbours in the document on one baseline whose runs differ only in their text and where it sits. */
function continues(previous: GlyphRunPrimitive, next: GlyphRunPrimitive) {
  return (
    previous.docEnd !== undefined &&
    previous.docEnd === next.docStart &&
    previous.glyphs[0]?.y === next.glyphs[0]?.y &&
    style(previous) === style(next)
  );
}

function style(run: GlyphRunPrimitive) {
  return JSON.stringify({
    ...run,
    text: undefined,
    glyphs: undefined,
    docStart: undefined,
    docEnd: undefined,
    logicalOrder: undefined,
  });
}

/** Glyphs whose clusters, UTF-8 offsets into their run's text, now follow `before`. */
function shifted(glyphs: GlyphRunPrimitive["glyphs"], before: string) {
  const offset = new TextEncoder().encode(before).length;

  return glyphs.map((glyph) => ({ ...glyph, cluster: glyph.cluster + offset }));
}

function fitted(run: GlyphRunPrimitive, measure: OffscreenCanvasRenderingContext2D) {
  const first = run.glyphs[0];
  const last = run.glyphs.at(-1);

  if (!first || !last) return run;

  const room = last.x + (last.advance ?? 0) - first.x;
  const font = run.fallbackFont ?? `${run.size}px sans-serif`;

  measure.font = font;

  const width = measure.measureText(run.text).width;

  if (width <= room || room <= 0) return run;

  // Smaller rather than narrower, so emoji keep their shape.
  return {
    ...run,
    fallbackFont: font.replace(
      /(\d+(?:\.\d+)?)px/u,
      (_, size) => `${(Number(size) * room) / width}px`,
    ),
  };
}
