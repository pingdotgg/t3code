import {
  checkpointFileTotals,
  type ThreadCheckpointSummary,
} from "@t3tools/client-runtime/state/thread-checkpoints";

import type { RightPanelSurface } from "~/rightPanelStore";

export type RightPanelSection = "changes" | "terminal" | "browser";

const SECTION_SURFACE_KIND = {
  changes: "diff",
  terminal: "terminal",
  browser: "preview",
} as const satisfies Record<RightPanelSection, RightPanelSurface["kind"]>;

export function rightPanelSectionOf(surface: RightPanelSurface | undefined) {
  if (!surface) return null;
  for (const [section, kind] of Object.entries(SECTION_SURFACE_KIND)) {
    if (surface.kind === kind) return section as RightPanelSection;
  }
  return null;
}

/**
 * The surface a section tab shows: the active one when it already belongs to the section,
 * else the newest of its kind. Null means the section has none yet and must create one.
 */
export function rightPanelSectionTarget(
  surfaces: readonly RightPanelSurface[],
  activeSurfaceId: string | null,
  section: RightPanelSection,
): RightPanelSurface | null {
  const kind = SECTION_SURFACE_KIND[section];
  const active = surfaces.find((surface) => surface.id === activeSurfaceId);
  if (active?.kind === kind) return active;
  return surfaces.findLast((surface) => surface.kind === kind) ?? null;
}

/** The Changes tab stands for the diff surface, so the diff gets no tab of its own. */
export function rightPanelDynamicTabSurfaces(
  surfaces: readonly RightPanelSurface[],
): readonly RightPanelSurface[] {
  return surfaces.filter((surface) => surface.kind !== "diff");
}

export function latestTurnChangedFileCount(
  summaries: ReadonlyArray<ThreadCheckpointSummary>,
): number | null {
  let latest: ThreadCheckpointSummary | undefined;
  for (const summary of summaries) {
    if (!latest || summary.checkpointTurnCount > latest.checkpointTurnCount) latest = summary;
  }
  return latest ? checkpointFileTotals(latest).count : null;
}
