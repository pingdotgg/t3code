import type { SVGProps } from "react";

// Continuum's mark (an open ring that keeps going). The export keeps upstream's name so
// upstream changes to its call sites still merge.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M48.35 46.72A22 22 0 1 1 48.35 17.28"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="9"
      />
      <circle cx="54" cy="32" fill="currentColor" r="5" />
    </svg>
  );
}
