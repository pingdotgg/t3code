import { cn } from "~/lib/utils";

/** The Linear issue a thread was launched from, right-aligned and muted in sidebar rows. */
export function LinearThreadIdentifier({
  identifier,
  className,
}: {
  identifier: string | null;
  className?: string;
}) {
  if (identifier === null) return null;
  return (
    <span
      data-testid="sidebar-linear-identifier"
      className={cn("shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/80", className)}
    >
      {identifier}
    </span>
  );
}
