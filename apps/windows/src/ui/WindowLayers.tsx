import { gradientCss } from "../theme/palette.ts";

/**
 * The three layers the app paints between the DWM system backdrop and its
 * content: window plate, scenery, legibility wash.
 *
 * Their alphas come from CSS custom properties written by `applyTheme()`, not
 * from props, so the honesty invariant ("photo + wash cover exactly the
 * translucency the user picked") lives in exactly one place —
 * `theme/glass.ts` — and cannot drift here.
 */
export function WindowLayers({
  seed,
  photoUrl,
}: {
  /** Thread or photo id; the same seed picks the same wash as on macOS. */
  readonly seed: string;
  /** Cached scenery photo, served through Tauri's asset protocol. */
  readonly photoUrl?: string | undefined;
}) {
  return (
    <div className="window-layers" aria-hidden="true">
      <div className="window-plate" />
      {/*
        One isolated group with one opacity. Fading the gradient and the photo
        separately would composite both and cover far more than the requested
        alpha — the CSS shape of the macOS `.compositingGroup()` trap.
      */}
      <div className="scenery">
        <div className="scenery__gradient" style={{ background: gradientCss(seed) }} />
        {photoUrl === undefined ? null : (
          <div className="scenery__photo" style={{ backgroundImage: `url(${photoUrl})` }} />
        )}
      </div>
      <div className="legibility-wash" />
    </div>
  );
}
