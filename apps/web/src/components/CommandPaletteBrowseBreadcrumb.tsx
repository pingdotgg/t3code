import type { BrowsePathSegment } from "@t3tools/client-runtime/state/projects";

import { cn } from "../lib/utils";

/**
 * The directory the picker is listing, one selectable crumb per level. The
 * typed path can point deeper than the listing (a partial folder name, or the
 * repository folder pinned onto a clone destination), so the crumbs are the
 * only place that always says which directory the rows below belong to.
 */
export function CommandPaletteBrowseBreadcrumb(props: {
  readonly segments: ReadonlyArray<BrowsePathSegment>;
  readonly onNavigate: (path: string) => void;
}) {
  if (props.segments.length === 0) {
    return null;
  }

  // Windows crumbs join with a backslash, and a root that is already a bare
  // separator ("/") must not gain another one before the first folder.
  const separator = props.segments[0]?.path.includes("\\") ? "\\" : "/";

  return (
    <nav
      aria-label="Folder path"
      className="flex flex-wrap items-center gap-0.5 px-3 pt-2 text-xs"
      data-testid="command-palette-browse-breadcrumb"
    >
      {props.segments.map((segment, index) => {
        const isCurrent = index === props.segments.length - 1;
        const previousLabel = index === 0 ? null : (props.segments[index - 1]?.label ?? null);
        return (
          <span className="flex items-center gap-0.5" key={segment.path}>
            {previousLabel !== null && !previousLabel.endsWith(separator) ? (
              <span className="text-muted-foreground/60">{separator}</span>
            ) : null}
            <button
              aria-current={isCurrent ? "location" : undefined}
              className={cn(
                "max-w-40 truncate rounded-sm px-1 py-0.5 text-start",
                isCurrent
                  ? "font-medium text-foreground"
                  : "cursor-pointer text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                if (!isCurrent) {
                  props.onNavigate(segment.path);
                }
              }}
              type="button"
            >
              {segment.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
