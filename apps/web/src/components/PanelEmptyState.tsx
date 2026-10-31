import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * What a right panel surface shows when it has nothing to render: a small glyph, one title, a
 * line of explanation and at most one way forward. The diff panel and the thread's pull request
 * list use it for empty, unavailable and failed states so they read like the pull request page's
 * "nothing matches" state rather than as loose captions.
 */
export function PanelEmptyState({
  icon,
  title,
  description,
  action,
  tone = "default",
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 py-8 text-center">
      <span
        aria-hidden
        className={cn(
          "mb-2 inline-flex [&_svg]:size-4",
          tone === "error" ? "text-error-foreground" : "text-dim-foreground",
        )}
      >
        {icon}
      </span>
      <p className="text-label text-foreground">{title}</p>
      {description ? (
        <p className="max-w-72 text-body text-muted-foreground wrap-anywhere">{description}</p>
      ) : null}
      {action ? <div className="mt-3 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
