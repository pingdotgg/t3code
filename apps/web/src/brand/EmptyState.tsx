import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { hoggies, type HoggieName } from "./hoggies";

const HOGGIE_SIZE = 120;

type EmptyStateProps = Readonly<{
  hoggie: HoggieName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}>;

/**
 * The standard "nothing here" panel: a hedgehog over a title, a line of
 * explanation, and an optional way out. Every empty and error surface uses
 * this so they read as one product rather than one-off illustrations.
 */
export function EmptyState({ hoggie, title, body, action, className }: EmptyStateProps) {
  const Hoggie = hoggies[hoggie];

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
      <Hoggie size={HOGGIE_SIZE} />
      <div className="flex max-w-sm flex-col gap-1.5">
        <p className="text-foreground text-sm font-semibold">{title}</p>
        {body ? <p className="text-muted-foreground text-sm">{body}</p> : null}
      </div>
      {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
