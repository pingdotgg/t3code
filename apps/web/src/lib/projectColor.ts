// A per-project accent colour, assigned by default and overridable per project.
//
// Two decisions shape everything here.
//
// The colour is a *hue angle*, never a finished colour. Lightness and chroma
// are pinned per theme at the render site, so a stored hue reads at the same
// weight as every other project's and stays legible in both themes. Storing a
// hex triple would let a project be "dark red on a dark sidebar", and would
// need a second value to survive a theme switch.
//
// The default is derived from the project key rather than assigned on create.
// A derived default needs no write path, no migration, and no repair when
// settings are wiped or a project is re-added on another machine: the same
// project lands on the same colour everywhere, for free. Only an explicit
// override is stored.
import type { ProjectColorHue } from "@t3tools/contracts";

/** One entry per swatch offered in the picker. */
export interface ProjectColorPaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly hue: ProjectColorHue;
}

/**
 * The ten default colours.
 *
 * Hues are spaced around the OKLCH circle but not evenly: the eye resolves far
 * more distinct hues in the 200–300 blue/violet arc than in the 40–90 yellows,
 * where small steps read as the same mustard. Spacing is widened there and
 * tightened through the blues so ten adjacent projects stay tellable apart.
 */
export const PROJECT_COLOR_PALETTE: readonly ProjectColorPaletteEntry[] = [
  { id: "red", label: "Red", hue: 25 as ProjectColorHue },
  { id: "orange", label: "Orange", hue: 55 as ProjectColorHue },
  { id: "amber", label: "Amber", hue: 90 as ProjectColorHue },
  { id: "lime", label: "Lime", hue: 130 as ProjectColorHue },
  { id: "green", label: "Green", hue: 155 as ProjectColorHue },
  { id: "teal", label: "Teal", hue: 190 as ProjectColorHue },
  { id: "sky", label: "Sky", hue: 225 as ProjectColorHue },
  { id: "blue", label: "Blue", hue: 260 as ProjectColorHue },
  { id: "violet", label: "Violet", hue: 300 as ProjectColorHue },
  { id: "pink", label: "Pink", hue: 340 as ProjectColorHue },
];

/**
 * FNV-1a. Tiny, allocation-free and — the part that matters — fully specified,
 * so the same key yields the same colour on every device and every release.
 * Anything seeded or implementation-defined would drift.
 */
function hashKey(key: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  // `>>> 0` keeps the result unsigned; Math.imul yields a signed int32.
  return hash >>> 0;
}

/**
 * The palette entry a project gets when nothing is stored for it.
 *
 * Deterministic, so it is not really random — but it is unpredictable enough
 * to spread a project list across the palette instead of handing the first
 * three projects three reds.
 */
export function defaultProjectColor(projectKey: string): ProjectColorPaletteEntry {
  const entry = PROJECT_COLOR_PALETTE[hashKey(projectKey) % PROJECT_COLOR_PALETTE.length];
  // Indexing by modulo of a non-empty array cannot miss; the fallback exists
  // only to keep the return type honest under noUncheckedIndexedAccess.
  return entry ?? PROJECT_COLOR_PALETTE[0]!;
}

/** The hue a project is drawn in: an explicit override, else the derived default. */
export function resolveProjectHue(
  projectKey: string,
  overrides: Readonly<Record<string, ProjectColorHue>> | undefined,
): ProjectColorHue {
  return overrides?.[projectKey] ?? defaultProjectColor(projectKey).hue;
}

/**
 * Inline style exposing the hue as a custom property.
 *
 * The hue travels as a CSS variable rather than a finished colour so the
 * light and dark lightness/chroma pairs can live in the class list, where they
 * respond to the theme. An inline colour could not.
 */
export function projectColorStyle(hue: ProjectColorHue): Record<string, string> {
  return { "--project-hue": String(hue) };
}

// Lightness and chroma are fixed per theme so only the hue varies between
// projects: every label reads at the same weight, and none competes with the
// thread title. The dark pair is lighter and slightly less saturated because a
// mid-lightness hue goes muddy against a dark surface.
//
// Both classes must resolve to the same colour — a swatch is a preview of the
// label, so they are defined together rather than in the two components that
// use them, where they would drift apart on the first tweak.
export const PROJECT_COLOR_TEXT_CLASS =
  "text-[oklch(0.52_0.12_var(--project-hue))] dark:text-[oklch(0.78_0.11_var(--project-hue))]";
export const PROJECT_COLOR_BG_CLASS =
  "bg-[oklch(0.52_0.12_var(--project-hue))] dark:bg-[oklch(0.78_0.11_var(--project-hue))]";
