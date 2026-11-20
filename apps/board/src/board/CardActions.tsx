import type { ReactNode } from "react";

const TONE = {
  primary: "bg-fg text-bg hover:opacity-90",
  quiet: "border border-line text-fg hover:bg-hover",
} as const;

/** A button on a For-you card, which a press on never starts a pan of the canvas. */
export function ActionButton({
  tone = "quiet",
  disabled,
  type = "button",
  onClick,
  children,
}: {
  tone?: keyof typeof TONE;
  disabled?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-[12px] leading-4 font-semibold disabled:opacity-40 ${TONE[tone]}`}
    >
      {children}
    </button>
  );
}
