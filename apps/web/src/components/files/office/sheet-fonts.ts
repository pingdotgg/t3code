import type { DisplayList } from "@betteroffice/xlsx";
import { loadFace, sheetFace } from "./fonts";

/**
 * The metric-compatible faces a workbook's cells draw with, such as Carlito for Calibri, added to the worker's font set
 * under the family name the painter asks for, so text widths, wrapping and overflow match Excel on machines without
 * Office fonts. A family the app ships no face for stays with the browser's own fallback.
 */
export function sheetFonts() {
  // SAFETY: a worker's global scope is a FontFaceSource, whose `fonts` is a FontFaceSet (CSS Font Loading, exposed to
  // workers). The window's types declare it on documents only. Without one, cells keep the browser's fallback.
  const fonts = "fonts" in self ? (self.fonts as FontFaceSet) : undefined;
  const loads = new Map<string, Promise<void>>();

  const load = (family: string, bold: boolean, italic: boolean) => {
    const key = `${family}\u0000${bold}\u0000${italic}`;
    const existing = loads.get(key);

    if (existing) return existing;

    const face = sheetFace(family, bold, italic);
    const loading =
      face && fonts
        ? loadFace(face)
            // A family without the requested style gets the face it has, which the browser then slants or emboldens.
            .then((bytes) =>
              new FontFace(family, bytes, {
                weight: face.weight === 700 ? "700" : "400",
                style: face.style === "italic" ? "italic" : "normal",
              }).load(),
            )
            .then((loaded) => void fonts.add(loaded))
            .catch(() => undefined)
        : Promise.resolve();

    loads.set(key, loading);

    return loading;
  };

  /** Loads the faces a frame's cell text uses before it paints. */
  return (lists: readonly DisplayList[]) =>
    Promise.all(
      lists.flatMap((list) =>
        list.commands.flatMap((command) => {
          // Chart text arrives as a CSS family list whose first family is the one to load.
          const family =
            command.op === "text"
              ? (/^"([^"]+)"/.exec(command.fontFamily ?? "")?.[1] ?? command.fontFamily)
              : undefined;

          return command.op === "text" && family
            ? [load(family, !!command.bold, !!command.italic)]
            : [];
        }),
      ),
    );
}
