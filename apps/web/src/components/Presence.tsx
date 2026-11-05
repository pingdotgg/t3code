import type { CSSProperties, ReactNode } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { usePresence } from "~/hooks/usePresence";
import { cn } from "~/lib/utils";

const EXIT_DURATION_MS = { pop: 140, collapse: 210 } as const;

/**
 * Keeps conditional content mounted long enough to animate out. The last children shown stay
 * rendered while closing, so callers can pass `null` children once `show` turns false.
 */
export function Presence({
  show,
  children,
  className,
  style,
  variant = "pop",
}: {
  readonly show: boolean;
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly variant?: "pop" | "collapse";
}) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const presence = usePresence(
    show,
    children,
    !prefersReducedMotion,
    null,
    EXIT_DURATION_MS[variant],
  );
  if (!presence.present) return null;
  return (
    <div
      data-slot="presence"
      data-closing={show ? undefined : ""}
      inert={!show}
      className={cn(variant === "pop" ? "presence-pop" : "presence-collapse", className)}
      style={style}
    >
      {presence.value}
    </div>
  );
}
