import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { CollapsibleTrigger } from "../ui/collapsible";

export function SettingsDisclosureHeader({
  label,
  expanded,
  children,
  actions,
}: {
  readonly label?: string | undefined;
  readonly expanded: boolean;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-3 px-3 py-3 sm:px-4",
        label && "transition-colors hover:bg-muted/20",
      )}
    >
      {label ? (
        <CollapsibleTrigger
          aria-label={label}
          render={
            <button
              type="button"
              className="absolute inset-0 rounded-[inherit] outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:forced-colors:-outline-offset-2"
            />
          }
        />
      ) : null}
      <div className="pointer-events-none relative min-w-0 flex-1 space-y-1 [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
        {children}
      </div>
      <div className="pointer-events-none relative flex shrink-0 items-center gap-2">
        {label ? (
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        ) : null}
        {actions ? (
          <div className="pointer-events-auto flex items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
