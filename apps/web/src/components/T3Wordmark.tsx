import type { SVGProps } from "react";

// Chromeria (toolboxmd fork): the product mark is the Chromeria obelisk icon,
// served from apps/web/public. Callers size it by height like the T3 glyph.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <image href="/chromeria-mark.png" width="64" height="64" />
    </svg>
  );
}
