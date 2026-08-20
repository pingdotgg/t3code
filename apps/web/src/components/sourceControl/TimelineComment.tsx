/**
 * One comment on a timeline rail: who said it, what the entry calls it, when, and the body as the
 * surface renders it. The rows around it — a commit, a lifecycle change, an issue event — differ
 * per surface and stay there; what somebody wrote reads the same on both.
 */
import type { SourceControlActor } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";

import { SourceControlMetaLine } from "./actorPresentation";
import { Button } from "../ui/button";

export function TimelineComment({
  actor,
  title,
  at,
  url,
  badge,
  meta,
  actions,
  body,
  onOpen,
}: {
  actor: SourceControlActor | null;
  /** What the entry is called — "commented", "reviewed", "left a review comment". */
  title: string;
  at: string;
  url: string | null;
  /** Said beside the title, for what the surface adds to it — a review's own state. */
  badge?: ReactNode;
  /** Further segments for the meta line, after the time. */
  meta?: ReactNode;
  /** Compact controls beside the host link, such as editing a comment. */
  actions?: ReactNode;
  body: ReactNode;
  onOpen: (url: string) => void;
}) {
  return (
    <article className="py-2">
      <div className="px-2">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
              {/* GitHub attributes work from a deleted account to "ghost"; say the same word. */}
              <span className="font-semibold text-foreground">{actor?.login ?? "ghost"}</span>
              <span className="text-muted-foreground">{title}</span>
              {badge}
            </div>
            <SourceControlMetaLine className="mt-1 flex-wrap text-[11px] text-muted-foreground">
              <span>{formatRelativeTimeLabel(at)}</span>
              {meta}
            </SourceControlMetaLine>
          </div>
          {actions}
          {url === null ? null : (
            <Button
              size="icon-xs"
              variant="ghost"
              className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
              aria-label="Open activity on host"
              onClick={() => onOpen(url)}
            >
              <ExternalLinkIcon className="size-3" />
            </Button>
          )}
        </div>
      </div>
      {body === null ? null : (
        <div className="px-2 pb-2">
          <div className="mt-3">{body}</div>
        </div>
      )}
    </article>
  );
}
