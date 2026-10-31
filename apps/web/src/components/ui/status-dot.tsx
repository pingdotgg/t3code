import { cva, type VariantProps } from "class-variance-authority";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

// Tones are the status hues; `neutral` is an idle or unknown state and
// `foreground` is the text color (an update in progress beside its label).
const statusDotVariants = cva("relative inline-flex shrink-0 rounded-full", {
  defaultVariants: { size: "sm", tone: "neutral" },
  variants: {
    size: {
      // Inline beside text.
      sm: "size-1.5",
      // A connection's state, or a badge on an avatar.
      md: "size-2",
    },
    tone: {
      neutral: "bg-dim-foreground",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-destructive",
      info: "bg-info",
      merged: "bg-merged",
      foreground: "bg-foreground",
    },
  },
});

const pingToneClassName = {
  neutral: "bg-dim-foreground/60",
  success: "bg-success/60",
  warning: "bg-warning/60",
  danger: "bg-destructive/60",
  info: "bg-info/60",
  merged: "bg-merged/60",
  foreground: "bg-foreground/60",
} as const;

type StatusDotTone = NonNullable<VariantProps<typeof statusDotVariants>["tone"]>;

/** Labels make dots focusable with a tooltip; unlabeled dots need nearby state text.
 * Framing keeps connection rows aligned; pulse and ping are duty-cycled. */
function StatusDot({
  tone = "neutral",
  size = "sm",
  pulse = false,
  ping = false,
  framed = ping,
  label,
}: {
  tone?: StatusDotTone;
  size?: "sm" | "md";
  pulse?: boolean;
  ping?: boolean;
  framed?: boolean;
  label?: string | null | undefined;
}) {
  const dot = (
    <span
      aria-hidden
      className={statusDotVariants({
        size,
        tone,
        className: pulse && "motion-safe:animate-status-pulse",
      })}
      data-slot="status-dot"
      data-tone={tone}
    />
  );
  const halo = ping ? (
    <span
      aria-hidden
      className={`absolute inline-flex h-full w-full motion-safe:animate-status-ping rounded-full ${pingToneClassName[tone]}`}
    />
  ) : null;

  if (label) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
            />
          }
        >
          {halo}
          {dot}
        </TooltipTrigger>
        <TooltipPopup side="top" className="whitespace-pre-wrap">
          {label}
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (framed) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {halo}
        {dot}
      </span>
    );
  }
  return dot;
}

export { StatusDot, type StatusDotTone };
