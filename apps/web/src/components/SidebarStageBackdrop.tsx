import { useAtomValue } from "@effect/atom-react";
import { useId } from "react";

import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { primaryServerConfigAtom } from "../state/server";

export type SidebarStageBackdropVariant = "nightly" | "dev";
export type EnvironmentIdentificationPillLabel = "Dev" | "Nightly";

// A wide viewBox keeps the 96-unit art height at a fixed scale while sidebar resizing reveals
// more horizontal canvas instead of zooming the scene.
const STAGE_BACKDROP_VIEW_BOX = "0 0 8192 96";

export function resolveSidebarStageBackdropVariant(
  stageLabel: string,
  enabled = true,
): SidebarStageBackdropVariant | null {
  if (!enabled) return null;
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "nightly") return "nightly";
  if (normalized === "dev") return "dev";
  return null;
}

export function resolveSidebarStageFocusRingOffsetClass(
  variant: SidebarStageBackdropVariant,
): string {
  return variant === "nightly"
    ? "focus-visible:ring-offset-(--stage-night-bottom)"
    : "focus-visible:ring-offset-(--stage-art-bottom)";
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string,
): EnvironmentIdentificationPillLabel | null {
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "dev") return "Dev";
  if (normalized === "nightly") return "Nightly";
  return null;
}

export function useEnvironmentStageLabel(): string {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useSidebarStageBackdropVariant(enabled = true): SidebarStageBackdropVariant | null {
  return resolveSidebarStageBackdropVariant(useEnvironmentStageLabel(), enabled);
}

/** Stage-channel header art; palettes mirror the per-channel app icons in `assets/`. */
export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <StageBackdropArt variant={variant} />
    </div>
  );
}

export function StageBackdropArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return variant === "nightly" ? <NightlySkyArt /> : <DevBlueprintArt />;
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return variant === "nightly" ? <NightlySkyArt compact /> : <DevBlueprintArt compact />;
}

/** The sidebar background the header art dissolves into, set by the sidebar-stage-backdrop utility. */
const STAGE_FADE = "var(--stage-fade)";

/** A dissolve into the sidebar across the lower part of the art, stepping in OKLCH so light sidebars pass through tints of the art's own hue instead of gray. */
function StageDissolve({ id, anchor }: { id: string; anchor: string }) {
  const mix = (pct: number) => `color-mix(in oklch, ${STAGE_FADE} ${pct}%, ${anchor})`;
  return (
    <linearGradient id={id} x1="0" y1="20" x2="0" y2="96" gradientUnits="userSpaceOnUse">
      <stop style={{ stopColor: mix(15) }} stopOpacity="0" />
      <stop offset="0.25" style={{ stopColor: mix(30) }} stopOpacity="0.35" />
      <stop offset="0.5" style={{ stopColor: mix(55) }} stopOpacity="0.7" />
      <stop offset="0.75" style={{ stopColor: mix(80) }} stopOpacity="0.92" />
      <stop offset="1" style={{ stopColor: STAGE_FADE }} />
    </linearGradient>
  );
}

type Star = { cx: number; cy: number; r: number; opacity: number };

/**
 * Deterministic star field for one 640-unit tile, kept out of the wordmark corner and
 * the lower half where the sky dissolves. Three size classes; the largest get a glint.
 */
function createStarField(seed: number, count: number): ReadonlyArray<Star> {
  const stars: Star[] = [];
  let n = seed;
  const random = () => {
    n = (n * 1103515245 + 12345) % 2147483648;
    return n / 2147483648;
  };
  while (stars.length < count) {
    const cx = Math.round(random() * 640);
    const cy = Math.round(random() * 70 + 2);
    if ((cx < 96 && cy < 36) || cy > 50) continue;
    const k = random();
    const r = k > 0.94 ? 0.95 : k > 0.72 ? 0.62 : 0.38;
    const opacity = k > 0.94 ? 0.95 : k > 0.72 ? 0.75 : 0.35 + random() * 0.3;
    stars.push({ cx, cy, r, opacity: Number(opacity.toFixed(2)) });
  }
  return stars;
}

const NIGHTLY_STARS = createStarField(79, 28);

function NightlySkyArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const skyId = `${idPrefix}-stage-night-sky`;
  const hazeId = `${idPrefix}-stage-night-haze`;
  const hazePatternId = `${idPrefix}-stage-night-haze-pattern`;
  const starsId = `${idPrefix}-stage-night-stars`;
  const fadeId = `${idPrefix}-stage-night-fade`;

  return (
    <svg
      className={`stage-art stage-nightly h-full w-full${compact ? " scale-110 blur-[1.6px]" : ""}`}
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "96 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={skyId}
          x1="24"
          y1="0"
          x2="264"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={{ stopColor: "var(--stage-night-bottom)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--stage-night-mid)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-night-top)" }} />
        </linearGradient>
        {/* Soft diagonal haze instead of a radial glow, blurred once and tiled. */}
        <filter id={hazeId} x="-10%" y="-60%" width="120%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <pattern id={hazePatternId} width="640" height="96" patternUnits="userSpaceOnUse">
          <g filter={`url(#${hazeId})`} fill="none" strokeLinecap="round">
            <path
              d="M-40 72C80 30 170 92 300 40S520 18 680 58"
              style={{ stroke: "var(--stage-night-glow-highlight)" }}
              strokeOpacity="0.26"
              strokeWidth="24"
            />
            <path
              d="M-40 18C100 62 220 -4 360 52S560 92 680 28"
              style={{ stroke: "var(--stage-night-glow-secondary)" }}
              strokeOpacity="0.22"
              strokeWidth="34"
            />
          </g>
        </pattern>
        <pattern id={starsId} width="640" height="96" patternUnits="userSpaceOnUse">
          <g style={{ fill: "var(--stage-night-line)" }}>
            {NIGHTLY_STARS.map((star) => (
              <circle
                key={`${star.cx}-${star.cy}`}
                cx={star.cx}
                cy={star.cy}
                r={star.r}
                fillOpacity={star.opacity}
              />
            ))}
          </g>
          <g
            style={{ stroke: "var(--stage-night-sparkle)" }}
            strokeLinecap="round"
            strokeOpacity="0.85"
            strokeWidth="0.6"
          >
            {NIGHTLY_STARS.filter((star) => star.r > 0.9).map((star) => (
              <g key={`${star.cx}-${star.cy}`}>
                <path d={`M${star.cx - 2.4} ${star.cy}H${star.cx + 2.4}`} />
                <path d={`M${star.cx} ${star.cy - 2.4}V${star.cy + 2.4}`} />
              </g>
            ))}
          </g>
        </pattern>
        <StageDissolve id={fadeId} anchor="var(--stage-night-mid)" />
      </defs>

      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect width="100%" height="96" fill={`url(#${hazePatternId})`} />
      <rect width="100%" height="96" fill={`url(#${starsId})`} />
      {/* The send-button crop sits on the composer, not the sidebar, so it keeps the raw art. */}
      {compact ? null : <rect width="100%" height="96" fill={`url(#${fadeId})`} />}
    </svg>
  );
}

function DevBlueprintArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const paperId = `${idPrefix}-stage-bp-paper`;
  const glowId = `${idPrefix}-stage-bp-glow`;
  const celesteGlowId = `${idPrefix}-stage-bp-glow-celeste`;
  const violetGlowId = `${idPrefix}-stage-bp-glow-violet`;
  const minorGridId = `${idPrefix}-stage-bp-grid-minor`;
  const majorGridId = `${idPrefix}-stage-bp-grid-major`;
  const rulerId = `${idPrefix}-stage-bp-ruler`;
  const glowsId = `${idPrefix}-stage-bp-glows`;
  const annotationsId = `${idPrefix}-stage-bp-annotations`;
  const fadeId = `${idPrefix}-stage-bp-fade`;

  return (
    <svg
      className={`stage-art stage-blueprint h-full w-full${compact ? " scale-110 blur-[1.6px]" : ""}`}
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "64 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={paperId}
          x1="60"
          y1="0"
          x2="220"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={{ stopColor: "var(--stage-art-bottom)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--stage-art-mid)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-art-top)" }} />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 14) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-art-highlight)" }} stopOpacity="0.4" />
          <stop
            offset="0.52"
            style={{ stopColor: "var(--stage-art-secondary)" }}
            stopOpacity="0.16"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={celesteGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(474 44) rotate(166) scale(156 92)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-art-celeste-highlight)" }} stopOpacity="0.34" />
          <stop
            offset="0.5"
            style={{ stopColor: "var(--stage-art-celeste-secondary)" }}
            stopOpacity="0.18"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={violetGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(704 18) rotate(145) scale(132 88)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "var(--stage-art-violet-highlight)" }} stopOpacity="0.3" />
          <stop
            offset="0.52"
            style={{ stopColor: "var(--stage-art-tertiary)" }}
            stopOpacity="0.14"
          />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} stopOpacity="0" />
        </radialGradient>
        <pattern id={minorGridId} width="8" height="8" patternUnits="userSpaceOnUse">
          <path
            d="M8 0H0V8"
            style={{ stroke: "var(--stage-art-grid-line)" }}
            strokeOpacity="0.14"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={majorGridId} width="32" height="32" patternUnits="userSpaceOnUse">
          <path
            d="M32 0H0V32"
            style={{ stroke: "var(--stage-art-grid-line)" }}
            strokeOpacity="0.26"
            strokeWidth="0.6"
          />
        </pattern>
        <pattern id={rulerId} width="32" height="6" patternUnits="userSpaceOnUse">
          <path
            d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5"
            style={{ stroke: "var(--stage-art-line)" }}
            strokeOpacity="0.5"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={glowsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <rect width="768" height="96" fill={`url(#${glowId})`} />
          <rect width="768" height="96" fill={`url(#${celesteGlowId})`} />
          <rect width="768" height="96" fill={`url(#${violetGlowId})`} />
        </pattern>
        <pattern id={annotationsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <g
            style={{ stroke: "var(--stage-art-line)" }}
            strokeLinecap="round"
            strokeOpacity="0.6"
            strokeWidth="0.7"
          >
            <path d="M180 64H264" strokeDasharray="5 4" />
            <path d="M180 61V67M264 61V67" />
            <path d="M276 10V44" strokeDasharray="4 4" strokeOpacity="0.5" />
            <path d="M273 10H279M273 44H279" strokeOpacity="0.5" />
            <path d="M348 30H428" strokeDasharray="3.5 5" strokeOpacity="0.5" />
            <path d="M348 27V33M428 27V33" strokeOpacity="0.5" />
            <path d="M512 48V80" strokeDasharray="5 3" strokeOpacity="0.45" />
            <path d="M509 48H515M509 80H515" strokeOpacity="0.45" />
            <path d="M590 70H724" strokeDasharray="7 4" strokeOpacity="0.55" />
            <path d="M590 67V73M724 67V73" strokeOpacity="0.55" />
          </g>

          <g
            style={{ stroke: "var(--stage-art-line)" }}
            strokeLinecap="round"
            strokeOpacity="0.55"
            strokeWidth="0.6"
          >
            <g>
              <path d="M34 60L38 64M38 60L34 64" />
            </g>
            <g>
              <path d="M228 26H234M231 23V29" />
            </g>
            <g>
              <path d="M143 51H149M146 48V54" />
            </g>
            <g>
              <path d="M316 16L322 22M322 16L316 22" />
            </g>
            <g>
              <path d="M468 70H476M472 66V74" />
            </g>
            <g>
              <path d="M558 28L564 34M564 28L558 34" />
            </g>
            <g>
              <path d="M742 44H750M746 40V48" />
            </g>
          </g>

          <g style={{ stroke: "var(--stage-art-line)" }} strokeOpacity="0.35" strokeWidth="0.6">
            <circle cx="196" cy="38" r="13" strokeDasharray="3.5 4" />
            <path d="M196 33V43M191 38H201" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="414" cy="64" r="10" strokeDasharray="2.5 3.5" />
            <path d="M414 60V68M410 64H418" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="648" cy="32" r="15" strokeDasharray="4 5" />
            <path d="M648 26V38M642 32H654" strokeOpacity="0.6" strokeWidth="0.4" />
          </g>
        </pattern>
        <StageDissolve id={fadeId} anchor="var(--stage-art-mid)" />
      </defs>

      <rect width="100%" height="96" fill={`url(#${paperId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${minorGridId})`} />
      <rect width="100%" height="96" fill={`url(#${majorGridId})`} />
      <rect width="100%" height="6" fill={`url(#${rulerId})`} />
      <rect width="100%" height="96" fill={`url(#${annotationsId})`} />
      {/* The send-button crop sits on the composer, not the sidebar, so it keeps the raw art. */}
      {compact ? null : <rect width="100%" height="96" fill={`url(#${fadeId})`} />}
    </svg>
  );
}
