import { type SidebarProjectColor } from "@t3tools/contracts/settings";

/**
 * Tailwind classes used to render a sidebar project's color identity. The
 * palette keys are persisted as `SidebarProjectColor` literals in client
 * settings; this module is the single mapping point from those keys to
 * concrete classes used by the sidebar UI.
 *
 * - `tintClass`: Applied to the group's `<li>` wrapper. Uses very low alpha
 *   so the color reads as a faint wash, not a card surface.
 * - `dotClass`: Applied to the always-visible color dot next to the new-thread
 *   button (and the swatches in the picker). Renders as a transparent
 *   interior with a saturated hue-matched ring, so the dot's interior shows
 *   whatever sits behind it (the tinted row, the popover surface, etc.) and
 *   only the ring carries the color identity.
 *
 * The class strings are written as literals so Tailwind's JIT can extract them.
 */
export interface SidebarProjectColorClasses {
  readonly key: SidebarProjectColor;
  readonly label: string;
  readonly tintClass: string;
  readonly dotClass: string;
}

export const SIDEBAR_PROJECT_COLOR_PALETTE: readonly SidebarProjectColorClasses[] = [
  {
    key: "slate",
    label: "Slate",
    tintClass: "bg-slate-500/8 dark:bg-slate-400/10",
    dotClass: "ring-2 ring-inset ring-slate-500/70 dark:ring-slate-400/70",
  },
  {
    key: "rose",
    label: "Rose",
    tintClass: "bg-rose-500/8 dark:bg-rose-400/10",
    dotClass: "ring-2 ring-inset ring-rose-500/70 dark:ring-rose-400/70",
  },
  {
    key: "orange",
    label: "Orange",
    tintClass: "bg-orange-500/8 dark:bg-orange-400/10",
    dotClass: "ring-2 ring-inset ring-orange-500/70 dark:ring-orange-400/70",
  },
  {
    key: "amber",
    label: "Amber",
    tintClass: "bg-amber-500/8 dark:bg-amber-400/10",
    dotClass: "ring-2 ring-inset ring-amber-500/70 dark:ring-amber-400/70",
  },
  {
    key: "emerald",
    label: "Emerald",
    tintClass: "bg-emerald-500/8 dark:bg-emerald-400/10",
    dotClass: "ring-2 ring-inset ring-emerald-500/70 dark:ring-emerald-400/70",
  },
  {
    key: "teal",
    label: "Teal",
    tintClass: "bg-teal-500/8 dark:bg-teal-400/10",
    dotClass: "ring-2 ring-inset ring-teal-500/70 dark:ring-teal-400/70",
  },
  {
    key: "sky",
    label: "Sky",
    tintClass: "bg-sky-500/8 dark:bg-sky-400/10",
    dotClass: "ring-2 ring-inset ring-sky-500/70 dark:ring-sky-400/70",
  },
  {
    key: "indigo",
    label: "Indigo",
    tintClass: "bg-indigo-500/8 dark:bg-indigo-400/10",
    dotClass: "ring-2 ring-inset ring-indigo-500/70 dark:ring-indigo-400/70",
  },
  {
    key: "violet",
    label: "Violet",
    tintClass: "bg-violet-500/8 dark:bg-violet-400/10",
    dotClass: "ring-2 ring-inset ring-violet-500/70 dark:ring-violet-400/70",
  },
  {
    key: "pink",
    label: "Pink",
    tintClass: "bg-pink-500/8 dark:bg-pink-400/10",
    dotClass: "ring-2 ring-inset ring-pink-500/70 dark:ring-pink-400/70",
  },
];

const PALETTE_BY_KEY = new Map<SidebarProjectColor, SidebarProjectColorClasses>(
  SIDEBAR_PROJECT_COLOR_PALETTE.map((entry) => [entry.key, entry] as const),
);

/**
 * 32-bit FNV-1a hash. Cheap, deterministic, and good enough for spreading
 * project keys across the palette without obvious clustering.
 */
function hashStringToUint32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // 32-bit FNV prime multiply (Math.imul keeps the result inside int32).
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Picks the deterministic auto-color for a project that has no override. The
 * same input always yields the same palette entry, so projects keep their
 * color across reloads even before the user customizes anything.
 */
export function autoSidebarProjectColor(seed: string): SidebarProjectColorClasses {
  const palette = SIDEBAR_PROJECT_COLOR_PALETTE;
  const index = hashStringToUint32(seed) % palette.length;
  return palette[index]!;
}

/**
 * Resolves the effective color for a project: the user's override if set,
 * otherwise the deterministic default derived from `seed` (typically the
 * project's physical override key).
 */
export function resolveSidebarProjectColor(
  seed: string,
  override: SidebarProjectColor | undefined,
): SidebarProjectColorClasses {
  if (override) {
    const palette = PALETTE_BY_KEY.get(override);
    if (palette) {
      return palette;
    }
  }
  return autoSidebarProjectColor(seed);
}

/**
 * Per-project color identity passed through the sidebar render tree. Carries
 * everything the row needs to paint the tint + dot and update overrides.
 */
export interface SidebarProjectColorIdentity {
  /** Stable key (physical project key) under which the override is stored. */
  readonly overrideKey: string;
  /** Resolved palette entry — auto if no override, else the user's pick. */
  readonly palette: SidebarProjectColorClasses;
  /** The user's explicit override key, or undefined when on auto. */
  readonly override: SidebarProjectColor | undefined;
}

/**
 * Shared empty map returned by callers when colorizing is disabled. Hoisted so
 * consumers can pass a stable reference to memoized children (e.g.
 * SidebarProjectsContent) without rebuilding an empty Map every render.
 */
export const EMPTY_SIDEBAR_PROJECT_COLOR_MAP: ReadonlyMap<string, SidebarProjectColorIdentity> =
  new Map();

export interface SidebarProjectColorInput {
  /** UI-scoped key the sidebar uses to look the entry back up. */
  readonly projectKey: string;
  /** Stable identity used both for the override map and the auto-color hash. */
  readonly overrideKey: string;
}

/**
 * Builds a color identity for every visible project group, with collision
 * avoidance across the auto-colored set.
 *
 * Algorithm:
 *  1. Pass 1 — claim every override's color before assigning auto colors so
 *     auto-projects never reuse a slot the user explicitly picked.
 *  2. Pass 2 — sort auto-projects by `overrideKey` (a stable, UI-independent
 *     order) and, for each, start at the FNV-1a hash position and walk
 *     forward through the palette until an unused slot is found. Sorting by
 *     `overrideKey` rather than by sidebar order means changing UI sort or
 *     grouping doesn't reshuffle established colors.
 *
 * If more than `palette.length` projects need auto colors, the overflow falls
 * back to the bare hash position (collisions are unavoidable past 10).
 */
export function buildSidebarProjectColorMap(input: {
  projects: ReadonlyArray<SidebarProjectColorInput>;
  overrides: Readonly<Record<string, SidebarProjectColor>>;
}): Map<string, SidebarProjectColorIdentity> {
  const palette = SIDEBAR_PROJECT_COLOR_PALETTE;
  const result = new Map<string, SidebarProjectColorIdentity>();
  const usedKeys = new Set<SidebarProjectColor>();

  // Pass 1: explicit overrides claim their slot first.
  const autoCandidates: SidebarProjectColorInput[] = [];
  for (const project of input.projects) {
    const override = input.overrides[project.overrideKey];
    const entry = override ? PALETTE_BY_KEY.get(override) : undefined;
    if (entry && override) {
      result.set(project.projectKey, {
        overrideKey: project.overrideKey,
        palette: entry,
        override,
      });
      usedKeys.add(override);
    } else {
      autoCandidates.push(project);
    }
  }

  // Pass 2: auto-color the rest in stable identity order so adding/removing
  // projects only perturbs colors that genuinely need to move.
  const sortedAuto = autoCandidates.toSorted((left, right) =>
    left.overrideKey.localeCompare(right.overrideKey),
  );
  for (const project of sortedAuto) {
    const startIndex = hashStringToUint32(project.overrideKey) % palette.length;
    let chosen = palette[startIndex]!;
    if (usedKeys.size < palette.length) {
      for (let step = 0; step < palette.length; step++) {
        const candidate = palette[(startIndex + step) % palette.length]!;
        if (!usedKeys.has(candidate.key)) {
          chosen = candidate;
          break;
        }
      }
    }
    result.set(project.projectKey, {
      overrideKey: project.overrideKey,
      palette: chosen,
      override: undefined,
    });
    usedKeys.add(chosen.key);
  }

  return result;
}
