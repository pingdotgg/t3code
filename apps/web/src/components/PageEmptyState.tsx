import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Text } from "./ui/text";

/** Fades a stack of ghost rows out toward the title. Shared by every page's ghost. */
export const PAGE_EMPTY_GHOST_OPACITY = ["opacity-70", "opacity-45", "opacity-25"];

/**
 * Page empties accept an icon, faded ghostRows, or a custom ghost. Use fill to center content
 * in the remaining scroll area when the page has no centered container.
 */
export function PageEmptyState({
  fill = false,
  icon,
  ghostRows = 0,
  ghost,
  title,
  description,
  children,
}: {
  fill?: boolean;
  icon?: ReactNode;
  ghostRows?: number;
  ghost?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-150 flex-col items-center gap-7 pt-8 text-center",
        fill && "flex-1 justify-center pb-16",
      )}
    >
      {ghost !== undefined ? (
        <div aria-hidden className="w-full max-w-105">
          {ghost}
        </div>
      ) : ghostRows > 0 ? (
        <div aria-hidden className="flex w-full max-w-105 flex-col gap-2">
          {Array.from({ length: ghostRows }, (_, index) => (
            <div
              key={index}
              className={cn(
                "flex items-center gap-3 rounded-card surface-card-settings px-3.5 py-3",
                PAGE_EMPTY_GHOST_OPACITY[index] ?? "opacity-40",
              )}
            >
              <span className="size-4 shrink-0 rounded-badge surface-raised" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="h-1.5 w-3/5 rounded-full surface-raised" />
                <span className="h-1.5 w-1/4 rounded-full surface-raised" />
              </span>
              <span className="h-5.5 w-16 shrink-0 rounded-control surface-raised" />
            </div>
          ))}
        </div>
      ) : icon !== undefined ? (
        <span
          aria-hidden
          className="inline-flex size-12 items-center justify-center rounded-card surface-raised text-foreground [&_svg:not([class*='size-'])]:size-4.5"
        >
          {icon}
        </span>
      ) : null}
      <div className="flex max-w-120 flex-col gap-1.5">
        <Text variant="label" emphasis render={<h2 />}>
          {title}
        </Text>
        <p className="text-body text-balance text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** A row of equal hint tiles under an empty state, optionally under a small heading. */
export function PageEmptyTiles({
  title,
  narrow = false,
  children,
}: {
  title?: string;
  /** Match the 420px text column instead of the full empty state. */
  narrow?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex w-full flex-col gap-2 text-left", narrow && "max-w-105")}>
      {/* Settings section rhythm: the title starts on the tile edge in a 28px row, 8px above
          the tiles, which sit 12px apart like the other settings tile grids. */}
      {title ? (
        <h3 className="flex min-h-7 items-center text-label text-dim-foreground">{title}</h3>
      ) : null}
      <div className="grid gap-3 sm:auto-cols-fr sm:grid-flow-col">{children}</div>
    </div>
  );
}

/** `aside` sits at the tile's top right; children pin to its bottom. */
export function PageEmptyTile({
  icon,
  title,
  description,
  aside,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    // The transparent border matches the settings cards and tiles, so text sits 13px in.
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-transparent surface-card-settings p-3">
      {aside ? (
        <span className="mb-1 flex items-center justify-between gap-2 text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0">
          {icon}
          {aside}
        </span>
      ) : null}
      <span className="flex items-center gap-2 text-body text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
        {aside ? null : icon}
        {title}
      </span>
      <span className="text-meta text-muted-foreground">{description}</span>
      {children ? <div className="mt-auto">{children}</div> : null}
    </div>
  );
}
