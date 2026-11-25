import { useId } from "react";

import horseMarkUrl from "../../../../assets/local/kaluwa-horse-mark.png";

// Fork: the local build's sidebar brand. The word කළුවා is set in the Su_Kanthi font and kept
// as outlines, so the font itself is not shipped.
const WORDMARK_VIEW_BOX = "2 -710 2374 950";
const WORDMARK_PATH =
  "M682 -40Q682 -7 660 15Q645 30 608 48L222 240Q225 240 315 177Q582 -10 582 -60V-470H422Q408 -470 352 -430L317 -405V-350H472Q489 -350 500.5 -338.5Q512 -327 512 -310V-40Q512 -23 500.5 -11.5Q489 0 472 0H322Q277 0 277 -25Q273 0 247 0H82Q65 0 53.5 -11.5Q42 -23 42 -40V-215L2 -185V-220L217 -380V-470H17L67 -500H277Q293 -500 305.0 -490.0Q317 -480 317 -465V-440L367 -480Q402 -500 422 -500H642Q659 -500 670.5 -488.5Q682 -477 682 -460ZM412 -30V-320H217V-345L142 -285V-30H227V-200H327V-30ZM1471 -40Q1471 -23 1459.5 -11.5Q1448 0 1431 0H961Q944 0 932.5 -11.5Q921 -23 921 -40V-290Q921 -307 932.5 -318.5Q944 -330 961 -330H1101V-470H871V-30H901V0H811Q794 0 782.5 -11.5Q771 -23 771 -40V-460Q771 -477 782.5 -488.5Q794 -500 811 -500H1161Q1178 -500 1189.5 -488.5Q1201 -477 1201 -460V-300H1021V-30H1371V-680H1301V-620Q1301 -603 1289.5 -591.5Q1278 -580 1261 -580H1051Q1034 -580 1022.5 -591.5Q1011 -603 1011 -620V-710H1431Q1448 -710 1459.5 -698.5Q1471 -687 1471 -670ZM1201 -610V-680H1111V-610ZM2118 -40Q2118 -23 2106.5 -11.5Q2095 0 2078 0H1618Q1595 0 1581.5 -18.5Q1568 -37 1568 -60V-290Q1568 -307 1579.5 -318.5Q1591 -330 1608 -330H1758V-470H1568L1608 -500H1818Q1835 -500 1846.5 -488.5Q1858 -477 1858 -460V-300H1668V-30H2018V-640H1568L1608 -670H2078Q2095 -670 2106.5 -658.5Q2118 -647 2118 -630ZM2376 -40Q2376 -18 2349 11Q2325 36 2302 48L1916 240Q1919 240 2009 177Q2276 -10 2276 -60V-470H2186L2216 -500H2336Q2353 -500 2364.5 -488.5Q2376 -477 2376 -460Z";

export function KaluwaBrandMark() {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden
        className="h-4 w-[0.7rem] shrink-0 bg-current"
        style={{
          maskImage: `url(${horseMarkUrl})`,
          maskRepeat: "no-repeat",
          maskSize: "contain",
          maskPosition: "center",
        }}
      />
      <svg
        role="img"
        // oxlint-disable-next-line t3code/no-untranslated-copy -- product wordmark
        aria-label="Kaluwa"
        viewBox={WORDMARK_VIEW_BOX}
        className="h-3.5 w-auto shrink-0"
        fill="currentColor"
      >
        <path d={WORDMARK_PATH} />
      </svg>
    </span>
  );
}

export function KaluwaStageBackdrop() {
  const idPrefix = useId().replaceAll(":", "");
  const deepId = `${idPrefix}-kaluwa-deep`;
  const glowId = `${idPrefix}-kaluwa-glow`;

  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
      // Runs across Kaluwa's navigation strip too, so the titlebar row reads as one band.
      style={{ left: "calc(var(--kaluwa-rail-width, 0px) * -1)" }}
    >
      <svg
        className="h-full w-full"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 320 80"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id={deepId} x1="0" y1="0" x2="320" y2="80" gradientUnits="userSpaceOnUse">
            <stop style={{ stopColor: "var(--kaluwa-deep)" }} />
            <stop offset="0.55" style={{ stopColor: "var(--kaluwa-mid)" }} />
            <stop offset="1" style={{ stopColor: "var(--kaluwa-bright)" }} />
          </linearGradient>
          <radialGradient
            id={glowId}
            cx="0"
            cy="0"
            r="1"
            gradientTransform="translate(250 10) rotate(150) scale(170 70)"
            gradientUnits="userSpaceOnUse"
          >
            <stop style={{ stopColor: "var(--kaluwa-glow)" }} stopOpacity="0.55" />
            <stop offset="1" style={{ stopColor: "var(--kaluwa-glow)" }} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="320" height="80" fill={`url(#${deepId})`} />
        <rect width="320" height="80" fill={`url(#${glowId})`} />
        <path
          d="M0 52C48 38 92 60 146 50C200 40 238 22 320 30V80H0Z"
          style={{ fill: "var(--kaluwa-wave)" }}
          fillOpacity="0.18"
        />
        <path
          d="M0 62C60 54 104 70 166 60C224 51 262 42 320 48V80H0Z"
          style={{ fill: "var(--kaluwa-wave-soft)" }}
          fillOpacity="0.12"
        />
        <path
          d="M0 44C52 30 100 52 150 42C204 31 246 16 320 22"
          style={{ stroke: "var(--kaluwa-line)" }}
          strokeOpacity="0.35"
          strokeWidth="0.8"
          fill="none"
        />
      </svg>
    </div>
  );
}
