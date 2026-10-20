import { FONT_FAMILIES } from "./fontFamilies";

export const MOBILE_FONT_ROLES = ["interface", "reply", "composer", "code"] as const;
export type MobileFontRole = (typeof MOBILE_FONT_ROLES)[number];
export type MobileFontSelections = Readonly<Record<MobileFontRole, string>>;
export interface MobileFontFamily {
  readonly regular: string;
  readonly medium: string;
  readonly bold: string;
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
