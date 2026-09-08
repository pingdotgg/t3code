import type { ProviderMode } from "../ProviderMode.ts";

/**
 * Pure formatting shared by the plan/deploy renderers (Ink TUI +
 * non-interactive LoggingCli) for the local-vs-live provider-mode
 * indicator on a resource row.
 *
 * The rule: in a dev run every mode-stamped row shows its mode — the
 * whole point of `alchemy dev` is knowing what is emulated and what is
 * real, so `(local)` and `(remote)` are both explicit. A live deploy
 * only tags the exceptions (`local` leftovers from dev being
 * deleted/replaced) — tagging every row `remote` in a normal deploy
 * would be noise.
 *
 * - `alchemy dev` (default `"local"`): local rows are tagged `local`,
 *   live rows are tagged `remote` — matching the `Alchemy.remote()`
 *   vocabulary users see. The persisted enum stays `"live"`; only the
 *   display says `remote`.
 * - `alchemy deploy` (default `"live"`): rows resolved to the local
 *   provider are tagged `local`; live rows are untagged.
 * - Mode-agnostic providers have no resolved mode (`undefined`) — nothing
 *   is shown.
 * - Mode-switch replacements ALWAYS annotate the transition
 *   (e.g. `local → live`), regardless of the run default.
 */

/** The display label for a mode-stamped row (`"live"` renders as `remote`). */
export const modeLabel = (mode: ProviderMode): string =>
  mode === "live" ? "remote" : "local";

/**
 * The mode note for a resource row, or `undefined` when nothing should be
 * shown (mode-agnostic rows, and live rows in a live-default run).
 *
 * @param mode the mode the node's provider was resolved for (`undefined`
 *   for mode-agnostic providers — never annotated)
 * @param priorMode for replacements, the mode the old generation was
 *   created with; when it differs from `mode` the transition is shown
 * @param defaultMode the run-level default (`alchemy dev` → `"local"`,
 *   otherwise `"live"`); `undefined` is treated as `"live"`
 */
export const formatModeNote = (options: {
  mode: ProviderMode | undefined;
  priorMode?: ProviderMode | undefined;
  defaultMode: ProviderMode | undefined;
}): string | undefined => {
  const { mode, priorMode } = options;
  if (mode === undefined) return undefined;
  // A genuine mode switch is always surfaced as the raw transition.
  if (priorMode !== undefined && priorMode !== mode) {
    return `${priorMode} → ${mode}`;
  }
  const defaultMode = options.defaultMode ?? "live";
  // Live-default runs stay quiet for live rows; dev runs tag everything.
  if (defaultMode === "live" && mode === "live") return undefined;
  return modeLabel(mode);
};
