import { PROJECT_ICON_COLORS } from "./projectIconColors";
import type { ProjectIconColor } from "@t3tools/contracts";

export interface ProjectIdentity {
  readonly monogram: string;
  readonly color: ProjectIconColor;
}

function normalizeProjectName(projectName: string): string {
  return projectName.normalize("NFKC").trim();
}

function projectMonogram(projectName: string): string {
  // One glyph: the first letter or number of the first word. A single mark
  // stays legible at 16px where two stretched letters turn to noise.
  const words = normalizeProjectName(projectName).match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = words[0] ? Array.from(words[0])[0] : undefined;
  return (first ?? "P").toUpperCase();
}

function projectColor(projectName: string): ProjectIconColor {
  const seed = normalizeProjectName(projectName).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_ICON_COLORS.length;
  }
  return PROJECT_ICON_COLORS[index]?.value ?? "blue";
}

export function deriveProjectIdentity(projectName: string): ProjectIdentity {
  return {
    monogram: projectMonogram(projectName),
    color: projectColor(projectName),
  };
}
