import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { ProjectIconColor, type ProjectIconOverride } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";

export type ProjectIconGlyph =
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "monogram"; readonly text: string; readonly color: ProjectIconColor };

/**
 * Hermes has no Intl.Segmenter, so combining marks are folded into their base
 * character instead of full grapheme segmentation.
 */
export function countGlyphs(text: string): number {
  return Array.from(text.replace(/\p{M}/gu, "")).length;
}

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

export function projectMonogramColor(projectName: string): ProjectIconColor {
  const seed = projectName.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % ProjectIconColor.literals.length;
  }
  return ProjectIconColor.literals[index] ?? "blue";
}

export function projectAutoMonogram(projectTitle: string): ProjectIconGlyph | null {
  if (!projectTitle.trim()) return null;
  return {
    kind: "monogram",
    text: projectMonogram(projectTitle),
    color: projectMonogramColor(projectTitle),
  };
}

export function resolveProjectIconGlyph(
  projectIcon: ProjectIconOverride | null | undefined,
  projectTitle: string,
): ProjectIconGlyph | null {
  switch (projectIcon?.kind) {
    case "emoji":
      return { kind: "emoji", emoji: projectIcon.emoji };
    case "monogram":
      return { kind: "monogram", text: projectIcon.text, color: projectIcon.color };
    case "lucide":
      return { kind: "monogram", text: projectMonogram(projectTitle), color: projectIcon.color };
    case undefined:
      return null;
  }
}

export type ProjectChipIcon = { readonly kind: "favicon"; readonly uri: string } | ProjectIconGlyph;

export function resolveProjectChipIcon(
  project: {
    readonly title: string;
    readonly workspaceRoot: string;
    readonly projectIcon?: ProjectIconOverride | null;
  } | null,
  scratchWorkspaceRoot: string | null | undefined,
  faviconUrl: () => string | null,
): ProjectChipIcon | null {
  if (!project || isScratchProject(project, scratchWorkspaceRoot)) return null;
  const glyph = resolveProjectIconGlyph(project.projectIcon, project.title);
  if (glyph) return glyph;
  const url = faviconUrl();
  if (url && !isProjectFaviconFallbackUrl(url)) return { kind: "favicon", uri: url };
  return projectAutoMonogram(project.title);
}

const PROJECT_ICON_COLOR_CLASSES: Record<
  ProjectIconColor,
  { readonly text: string; readonly background: string }
> = {
  gray: { text: "text-gray-500", background: "bg-gray-500/15" },
  red: { text: "text-red-500", background: "bg-red-500/15" },
  orange: { text: "text-orange-500", background: "bg-orange-500/15" },
  amber: { text: "text-amber-500", background: "bg-amber-500/15" },
  yellow: { text: "text-yellow-500", background: "bg-yellow-500/15" },
  lime: { text: "text-lime-500", background: "bg-lime-500/15" },
  green: { text: "text-green-500", background: "bg-green-500/15" },
  emerald: { text: "text-emerald-500", background: "bg-emerald-500/15" },
  teal: { text: "text-teal-500", background: "bg-teal-500/15" },
  cyan: { text: "text-cyan-500", background: "bg-cyan-500/15" },
  sky: { text: "text-sky-500", background: "bg-sky-500/15" },
  blue: { text: "text-blue-500", background: "bg-blue-500/15" },
  indigo: { text: "text-indigo-500", background: "bg-indigo-500/15" },
  violet: { text: "text-violet-500", background: "bg-violet-500/15" },
  purple: { text: "text-purple-500", background: "bg-purple-500/15" },
  fuchsia: { text: "text-fuchsia-500", background: "bg-fuchsia-500/15" },
  pink: { text: "text-pink-500", background: "bg-pink-500/15" },
  rose: { text: "text-rose-500", background: "bg-rose-500/15" },
};

export function projectIconColorClassNames(color: ProjectIconColor) {
  return PROJECT_ICON_COLOR_CLASSES[color];
}
