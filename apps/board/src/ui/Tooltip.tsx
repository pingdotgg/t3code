import type { ReactNode } from "react";

const SIDE = {
  top: "bottom-full mb-1",
  bottom: "top-full mt-1",
} as const;

const ALIGN = {
  start: "left-0",
  center: "left-1/2 -translate-x-1/2",
  /** For a control at the edge of its container, so the tip opens inward instead of past it. */
  end: "right-0",
} as const;

/** Shows on hover and on keyboard focus inside, which a native title does not. */
export function Tooltip({
  text,
  side = "top",
  align = "start",
  children,
}: {
  text: string;
  side?: keyof typeof SIDE;
  align?: keyof typeof ALIGN;
  children: ReactNode;
}) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-20 hidden w-max max-w-64 rounded-md border border-line bg-panel px-2 py-1 text-xs whitespace-normal text-fg shadow-panel group-focus-within/tip:block group-hover/tip:block ${SIDE[side]} ${ALIGN[align]}`}
      >
        {text}
      </span>
    </span>
  );
}
