import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";

export type ProjectIconGlyph =
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "monogram"; readonly text: string; readonly color: ProjectIconColor }
  | {
      readonly kind: "lucide";
      readonly paths: readonly string[];
      readonly color: ProjectIconColor;
    };

/**
 * Stroke paths for the Lucide icons the server assigns on its own, copied from
 * lucide-react so mobile draws the same shape as web.
 */
const LUCIDE_PATHS: Partial<Record<string, readonly string[]>> = {
  "message-square-dashed": [
    "M14 3h2",
    "M16 19h-2",
    "M2 12v-2",
    "M2 16v5.286a.71.71 0 0 0 1.212.502l1.149-1.149",
    "M20 19a2 2 0 0 0 2-2v-1",
    "M22 10v2",
    "M22 6V5a2 2 0 0 0-2-2",
    "M4 3a2 2 0 0 0-2 2v1",
    "M8 19h2",
    "M8 3h2",
  ],
};

/**
 * Visible glyph count for sizing monogram text. Hermes has no Intl.Segmenter, so combining
 * marks are folded into their base character instead of full grapheme segmentation.
 */
export function countGlyphs(text: string): number {
  return Array.from(text.replace(/\p{M}/gu, "")).length;
}

/** Mirrors the automatic monogram web derives from a project name when it has no favicon. */
export function projectMonogram(projectName: string): string {
  const words =
    projectName
      .normalize("NFKC")
      .trim()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";

  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

/**
 * Picks what mobile draws for an assigned project icon. Mobile does not bundle
 * the Lucide set, so a Lucide override keeps its color and draws the paths
 * mobile carries for it, else the project's monogram instead of the folder glyph.
 */
export function resolveProjectIconGlyph(
  projectIcon: ProjectIconOverride | null | undefined,
  projectTitle: string,
): ProjectIconGlyph | null {
  switch (projectIcon?.kind) {
    case "emoji":
      return { kind: "emoji", emoji: projectIcon.emoji };
    case "monogram":
      return { kind: "monogram", text: projectIcon.text, color: projectIcon.color };
    case "lucide": {
      const paths = LUCIDE_PATHS[projectIcon.name];
      return paths
        ? { kind: "lucide", paths, color: projectIcon.color }
        : { kind: "monogram", text: projectMonogram(projectTitle), color: projectIcon.color };
    }
    case undefined:
      return null;
  }
}

const PROJECT_ICON_COLOR_CLASSES: Record<
  ProjectIconColor,
  { readonly text: string; readonly tint: string; readonly background: string }
> = {
  gray: { text: "text-gray-500", tint: "accent-gray-500", background: "bg-gray-500/15" },
  red: { text: "text-red-500", tint: "accent-red-500", background: "bg-red-500/15" },
  orange: { text: "text-orange-500", tint: "accent-orange-500", background: "bg-orange-500/15" },
  amber: { text: "text-amber-500", tint: "accent-amber-500", background: "bg-amber-500/15" },
  yellow: { text: "text-yellow-500", tint: "accent-yellow-500", background: "bg-yellow-500/15" },
  lime: { text: "text-lime-500", tint: "accent-lime-500", background: "bg-lime-500/15" },
  green: { text: "text-green-500", tint: "accent-green-500", background: "bg-green-500/15" },
  emerald: {
    text: "text-emerald-500",
    tint: "accent-emerald-500",
    background: "bg-emerald-500/15",
  },
  teal: { text: "text-teal-500", tint: "accent-teal-500", background: "bg-teal-500/15" },
  cyan: { text: "text-cyan-500", tint: "accent-cyan-500", background: "bg-cyan-500/15" },
  sky: { text: "text-sky-500", tint: "accent-sky-500", background: "bg-sky-500/15" },
  blue: { text: "text-blue-500", tint: "accent-blue-500", background: "bg-blue-500/15" },
  indigo: { text: "text-indigo-500", tint: "accent-indigo-500", background: "bg-indigo-500/15" },
  violet: { text: "text-violet-500", tint: "accent-violet-500", background: "bg-violet-500/15" },
  purple: { text: "text-purple-500", tint: "accent-purple-500", background: "bg-purple-500/15" },
  fuchsia: {
    text: "text-fuchsia-500",
    tint: "accent-fuchsia-500",
    background: "bg-fuchsia-500/15",
  },
  pink: { text: "text-pink-500", tint: "accent-pink-500", background: "bg-pink-500/15" },
  rose: { text: "text-rose-500", tint: "accent-rose-500", background: "bg-rose-500/15" },
};

export function projectIconColorClassNames(color: ProjectIconColor) {
  return PROJECT_ICON_COLOR_CLASSES[color];
}
