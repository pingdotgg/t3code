import type { ReactNode } from "react";

const SIDE = {
  top: "bottom-full left-0 mb-1",
  bottom: "top-full left-0 mt-1",
} as const;

/** Shows on hover and on keyboard focus inside, which a native title does not. */
export function Tooltip({
  text,
  side = "top",
  children,
}: {
  text: string;
  side?: keyof typeof SIDE;
  children: ReactNode;
}) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-20 hidden w-max max-w-64 rounded-md border border-line bg-panel px-2 py-1 text-xs whitespace-normal text-fg shadow-panel group-focus-within/tip:block group-hover/tip:block ${SIDE[side]}`}
      >
        {text}
      </span>
    </span>
  );
}
