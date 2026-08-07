import type { SVGProps } from "react";

import { cn } from "../lib/utils";

/** The canonical lime rounded-diamond mark from the original 2code client. */
export function Brand2codeMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-label="2code"
      className={cn("shrink-0 text-[#b0fe93]", className)}
      fill="none"
      role="img"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect
        fill="currentColor"
        height="14.8"
        rx="5"
        transform="rotate(45 12 12)"
        width="14.8"
        x="4.6"
        y="4.6"
      />
    </svg>
  );
}
