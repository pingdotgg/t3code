import { FONT_FAMILIES } from "./fontFamilies";

export const MOBILE_FONT_ROLES = ["interface", "reply", "composer", "code"] as const;
export type MobileFontRole = (typeof MOBILE_FONT_ROLES)[number];
export type MobileFontSelections = Readonly<Record<MobileFontRole, string>>;
export interface MobileFontFamily {
  readonly regular: string;
  readonly medium: string;
  readonly bold: string;
  readonly emphasisFaces?: Readonly<Partial<Record<ReplyEmphasisWeight, string>>>;
}
export interface InstalledMobileFont extends MobileFontFamily {
  readonly name: string;
  readonly label: string;
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

const BUILT_IN_FAMILIES = {
  ios: {
    system: { regular: "System", medium: "System", bold: "System" },
    serif: {
      regular: "Georgia",
      medium: "Georgia",
      bold: "Georgia-Bold",
      emphasisFaces: { "700": "Georgia-Bold" },
    },
    mono: {
      regular: "Menlo-Regular",
      medium: "Menlo-Regular",
      bold: "Menlo-Bold",
      emphasisFaces: { "700": "Menlo-Bold" },
    },
  },
  android: {
    system: { regular: "sans-serif", medium: "sans-serif-medium", bold: "sans-serif" },
    serif: { regular: "serif", medium: "serif", bold: "serif" },
    mono: { regular: "monospace", medium: "monospace", bold: "monospace" },
  },
} as const;

export function reconcileInstalledFonts(
  previous: ReadonlyMap<string, InstalledMobileFont>,
  available: ReadonlyMap<string, InstalledMobileFont>,
): ReadonlyMap<string, InstalledMobileFont> {
  let changed = previous.size !== available.size;
  const next = new Map<string, InstalledMobileFont>();
  for (const [name, font] of available) {
    const prior = previous.get(name);
    const same =
      prior &&
      (["name", "label", "regular", "medium", "bold"] as const).every(
        (key) => prior[key] === font[key],
      ) &&
      REPLY_EMPHASIS_OPTIONS.every(
        ({ id }) => prior.emphasisFaces?.[id] === font.emphasisFaces?.[id],
      );
    if (!same) changed = true;
    next.set(name, same ? prior : font);
  }
  return changed ? next : previous;
}

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
          (candidate.startsWith("installed:") && candidate.slice(10).trim().length > 0))
          ? candidate
          : "",
      ];
    }),
  ) as unknown as MobileFontSelections;
}

export function resolveMobileFonts(
  selections: MobileFontSelections,
  installed: ReadonlyMap<string, InstalledMobileFont>,
  platform: string,
): Readonly<Record<MobileFontRole, MobileFontFamily>> {
  const defaults = FONT_FAMILIES;
  const { system, serif, mono } = BUILT_IN_FAMILIES[platform === "ios" ? "ios" : "android"];
  const resolve = (selection: string, fallback: MobileFontFamily): MobileFontFamily => {
    if (selection === "system") return system;
    if (selection === "serif") return serif;
    if (selection === "monospace") return mono;
    if (!selection.startsWith("installed:")) return fallback;
    return installed.get(selection.slice(10)) ?? fallback;
  };
  const interfaceFont = resolve(selections.interface, defaults);
  return {
    interface: interfaceFont,
    reply: resolve(selections.reply, interfaceFont),
    composer: resolve(selections.composer, interfaceFont),
    code: resolve(selections.code, mono),
  };
}

export const REPLY_EMPHASIS_OPTIONS = [
  { id: "500", label: "Medium" },
  { id: "600", label: "Semibold" },
  { id: "700", label: "Bold" },
] as const;
export type ReplyEmphasisWeight = (typeof REPLY_EMPHASIS_OPTIONS)[number]["id"];
export type ReplyEmphasisWeights = Readonly<Record<string, ReplyEmphasisWeight>>;

export function normalizeReplyEmphasisWeights(value: unknown): ReplyEmphasisWeights {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, ReplyEmphasisWeight] =>
        entry[0].length > 0 &&
        entry[0].length <= 250 &&
        REPLY_EMPHASIS_OPTIONS.some((option) => option.id === entry[1]),
    ),
  );
}

export function resolveReplyEmphasis(font: MobileFontFamily, weight?: ReplyEmphasisWeight) {
  return (weight && font.emphasisFaces?.[weight]) || font.bold;
}
