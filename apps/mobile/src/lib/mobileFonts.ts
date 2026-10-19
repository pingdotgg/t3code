import { FONT_FAMILIES } from "./fontFamilies";

export const MOBILE_FONT_ROLES = ["interface", "reply", "composer", "code"] as const;
export type MobileFontRole = (typeof MOBILE_FONT_ROLES)[number];
export type MobileFontSelections = Readonly<Record<MobileFontRole, string>>;
export interface ImportedFontFace {
  readonly id: string;
  readonly file: string;
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
}
export interface MobileFontFamily {
  readonly regular: string;
  readonly medium: string;
  readonly bold: string;
}
export const DEFAULT_FONT_SELECTIONS: MobileFontSelections = {
  interface: "",
  reply: "",
  composer: "",
  code: "",
};
export const BUILT_IN_FONT_OPTIONS = [
  { id: "", label: "Default" },
  { id: "system", label: "System sans" },
  { id: "serif", label: "Serif" },
  { id: "monospace", label: "Monospace" },
] as const;

export function normalizeFontSelections(value: unknown): MobileFontSelections {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    MOBILE_FONT_ROLES.map((role) => {
      const candidate = record[role];
      return [
        role,
        typeof candidate === "string" &&
        candidate.length <= 250 &&
        (BUILT_IN_FONT_OPTIONS.some((option) => option.id === candidate) ||
          candidate.startsWith("imported:"))
          ? candidate
          : "",
      ];
    }),
  ) as unknown as MobileFontSelections;
}

export function normalizeImportedFonts(value: unknown): readonly ImportedFontFace[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter((face): face is ImportedFontFace => {
      if (
        typeof face !== "object" ||
        face === null ||
        typeof face.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(face.id) ||
        seen.has(face.id) ||
        (face.file !== `${face.id}.ttf` && face.file !== `${face.id}.otf`) ||
        typeof face.family !== "string" ||
        face.family.trim().length === 0 ||
        face.family.length > 200 ||
        !Number.isInteger(face.weight) ||
        face.weight < 1 ||
        face.weight > 1000 ||
        typeof face.italic !== "boolean"
      )
        return false;
      seen.add(face.id);
      return true;
    })
    .slice(0, 64);
}

export function mergeImportedFonts(
  current: readonly ImportedFontFace[],
  incoming: readonly ImportedFontFace[],
) {
  const faces = [...current];
  for (const face of incoming) {
    const index = faces.findIndex(
      (old) =>
        old.family === face.family && old.weight === face.weight && old.italic === face.italic,
    );
    if (index === -1) faces.push(face);
    else faces[index] = face;
  }
  if (faces.length > 64)
    throw new Error("You can import up to 64 font faces. Remove unused fonts first.");
  return faces;
}

export function importedFontFamilies(faces: readonly ImportedFontFace[]) {
  return [...new Set(faces.map((face) => face.family))].sort((a, b) => a.localeCompare(b));
}

export function importedFontVariant(
  faces: readonly ImportedFontFace[],
  family: string,
  weight: number,
) {
  const candidates = faces.filter((face) => face.family === family);
  const upright = candidates.filter((face) => !face.italic);
  const chosen = [...(upright.length ? upright : candidates)].sort(
    (a, b) =>
      Math.abs(a.weight - weight) - Math.abs(b.weight - weight) ||
      a.weight - b.weight ||
      a.id.localeCompare(b.id),
  )[0];
  if (!chosen) return null;
  const matching = candidates
    .filter((face) => face.weight === chosen.weight)
    .sort((a, b) => Number(a.italic) - Number(b.italic));
  const alias = `T3Font-${matching.map((face) => face.id).join("-")}`;
  return { alias, faces: matching };
}

export function resolveMobileFonts(
  selections: MobileFontSelections,
  faces: readonly ImportedFontFace[],
  loaded: ReadonlySet<string>,
  platform: string,
): Readonly<Record<MobileFontRole, MobileFontFamily>> {
  const defaults = FONT_FAMILIES;
  const system =
    platform === "ios"
      ? { regular: "System", medium: "System", bold: "System" }
      : { regular: "sans-serif", medium: "sans-serif-medium", bold: "sans-serif" };
  const serif =
    platform === "ios"
      ? { regular: "Georgia", medium: "Georgia", bold: "Georgia-Bold" }
      : { regular: "serif", medium: "serif", bold: "serif" };
  const mono =
    platform === "ios"
      ? { regular: "Menlo-Regular", medium: "Menlo-Regular", bold: "Menlo-Bold" }
      : { regular: "monospace", medium: "monospace", bold: "monospace" };
  const resolve = (selection: string, fallback: MobileFontFamily): MobileFontFamily => {
    if (selection === "system") return system;
    if (selection === "serif") return serif;
    if (selection === "monospace") return mono;
    if (!selection.startsWith("imported:")) return fallback;
    const family = selection.slice(9);
    const regular = importedFontVariant(faces, family, 400);
    const medium = importedFontVariant(faces, family, 500);
    const bold = importedFontVariant(faces, family, 700);
    if (
      !regular ||
      !medium ||
      !bold ||
      ![regular, medium, bold].every((face) => loaded.has(face.alias))
    )
      return fallback;
    return { regular: regular.alias, medium: medium.alias, bold: bold.alias };
  };
  const interfaceFont = resolve(selections.interface, defaults);
  return {
    interface: interfaceFont,
    reply: resolve(selections.reply, interfaceFont),
    composer: resolve(selections.composer, interfaceFont),
    code: resolve(selections.code, mono),
  };
}

/** Names and style metadata are needed to group separately imported faces without guessing from filenames. */
export function readFontMetadata(bytes: Uint8Array): Omit<ImportedFontFace, "id" | "file"> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const requireRange = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > bytes.length)
      throw new Error("This font file is incomplete or invalid.");
  };
  const text = (offset: number, length: number, unicode = false) => {
    requireRange(offset, length);
    let value = "";
    for (let i = 0; i < length; i += unicode ? 2 : 1) {
      if (unicode && i + 1 >= length) break;
      value += String.fromCharCode(unicode ? view.getUint16(offset + i) : bytes[offset + i]!);
    }
    return value.replaceAll("\u0000", "").trim();
  };
  requireRange(0, 12);
  if (view.getUint32(0) !== 0x00010000 && text(0, 4) !== "OTTO")
    throw new Error("Choose a TrueType (.ttf) or OpenType (.otf) font file.");
  const tables = new Map<string, { offset: number; length: number }>();
  const tableCount = view.getUint16(4);
  requireRange(12, tableCount * 16);
  for (let index = 0; index < tableCount; index++) {
    const start = 12 + index * 16,
      offset = view.getUint32(start + 8),
      length = view.getUint32(start + 12);
    requireRange(offset, length);
    tables.set(text(start, 4), { offset, length });
  }
  if (tables.has("fvar"))
    throw new Error(
      "Choose static font faces. Variable fonts are not supported by this import yet.",
    );
  const names = tables.get("name");
  if (!names || names.length < 6) throw new Error("The font has no readable family name.");
  const count = view.getUint16(names.offset + 2),
    strings = names.offset + view.getUint16(names.offset + 4);
  if (6 + count * 12 > names.length) throw new Error("The font name table is invalid.");
  const values = new Map<number, { value: string; rank: number }>();
  for (let index = 0; index < count; index++) {
    const start = names.offset + 6 + index * 12;
    const platform = view.getUint16(start),
      language = view.getUint16(start + 4),
      id = view.getUint16(start + 6),
      length = view.getUint16(start + 8),
      offset = strings + view.getUint16(start + 10);
    if (platform !== 0 && platform !== 3 && platform !== 1) continue;
    if (offset < names.offset || offset + length > names.offset + names.length)
      throw new Error("The font name table is invalid.");
    const value = text(offset, length, platform !== 1);
    const rank = platform === 3 && language === 0x409 ? 3 : platform === 0 ? 2 : 1;
    if (value && rank > (values.get(id)?.rank ?? 0)) values.set(id, { value, rank });
  }
  const family = values.get(16)?.value ?? values.get(1)?.value;
  if (!family || family.length > 200) throw new Error("The font has no readable family name.");
  const os2 = tables.get("OS/2"),
    head = tables.get("head");
  const weight = os2 && os2.length >= 6 ? view.getUint16(os2.offset + 4) : 400;
  const italic =
    os2 && os2.length >= 64
      ? Boolean(view.getUint16(os2.offset + 62) & 1)
      : head && head.length >= 46
        ? Boolean(view.getUint16(head.offset + 44) & 2)
        : false;
  return { family, weight: Math.max(1, Math.min(1000, weight)), italic };
}
