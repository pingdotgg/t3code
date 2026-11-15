import { useId, type SVGProps } from "react";

// One-colour mark from assets/brand/mark-mono.svg. The ring is clipped around a slightly larger
// copy of the cursor so the two stay apart without a colour mask.
const CURSOR = "M62 60V102L72.5 91.5L81 108L91 103L82.5 87H98Z";
const CURSOR_GAP = "M59 54L59 109.2L71.7 96.5L79.7 112L95.1 104.3L87.5 90L107 90Z";

export function ExploroMark(props: SVGProps<SVGSVGElement>) {
  const clipId = `exploro-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg {...props} viewBox="23 23 78 88" fill="none" xmlns="http://www.w3.org/2000/svg">
      <clipPath id={clipId}>
        <path clipRule="evenodd" d={`M0 0H128V128H0Z${CURSOR_GAP}`} />
      </clipPath>
      <circle
        cx="56"
        cy="56"
        r="27"
        stroke="currentColor"
        strokeWidth="12"
        clipPath={`url(#${clipId})`}
      />
      <path d={CURSOR} fill="currentColor" />
    </svg>
  );
}
