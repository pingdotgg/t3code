import { FolderIcon } from "lucide-react";

import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

interface ThreadDetailLoadingStateProps {
  readonly projectTitle: string | null;
  readonly threadTitle: string | null;
}

/**
 * Paints the stable chat chrome while the detail snapshot catches up with the
 * shell snapshot. The placeholders are intentionally static so opening a large
 * thread does not add a continuously repainting animation.
 */
export function ThreadDetailLoadingState({
  projectTitle,
  threadTitle,
}: ThreadDetailLoadingStateProps) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading thread"
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      role="status"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <header
          className={cn(
            "workspace-topbar bg-background transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
            isElectron
              ? "drag-region relative px-3 sm:px-5"
              : "pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
          data-chat-header
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            {projectTitle ? (
              <span className="inline-flex shrink-0 items-center gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <FolderIcon aria-hidden className="size-3.5 shrink-0 opacity-50" />
                  <span className="max-w-40 truncate text-sm font-medium">{projectTitle}</span>
                </span>
                <span aria-hidden className="text-muted-foreground/40">
                  /
                </span>
              </span>
            ) : (
              <span aria-hidden className="h-3.5 w-24 shrink-0 rounded-sm bg-muted/55 sm:w-32" />
            )}
            {threadTitle ? (
              <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {threadTitle}
              </h2>
            ) : (
              <span aria-hidden className="h-3.5 w-36 max-w-1/3 rounded-sm bg-muted/55" />
            )}
            <div aria-hidden className="ml-auto flex shrink-0 items-center gap-2">
              <span className="size-7 rounded-md bg-muted/45" />
              <span className="size-7 rounded-md bg-muted/45" />
              <span className="size-7 rounded-md bg-muted/45" />
            </div>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            aria-hidden
            className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-5 pt-8 pb-40 sm:px-8 sm:pt-10"
          >
            <div className="space-y-2 opacity-65">
              <div className="h-3 w-20 rounded-sm bg-muted/55" />
              <div className="h-3 w-4/5 max-w-xl rounded-sm bg-muted/45" />
              <div className="h-3 w-3/5 max-w-md rounded-sm bg-muted/45" />
            </div>
            <div className="space-y-2 opacity-45">
              <div className="h-3 w-24 rounded-sm bg-muted/55" />
              <div className="h-3 w-11/12 max-w-2xl rounded-sm bg-muted/45" />
              <div className="h-3 w-2/3 max-w-lg rounded-sm bg-muted/45" />
              <div className="h-3 w-1/2 max-w-sm rounded-sm bg-muted/45" />
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2">
            <div className="chat-composer-horizontal-inset w-full">
              <div className="chat-composer-glass-shell relative mx-auto w-full max-w-3xl">
                <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
                  <div
                    aria-hidden
                    className="relative z-10 flex min-h-24 flex-col justify-between rounded-[22px] p-4"
                  >
                    <div className="h-3.5 w-36 rounded-sm bg-muted/50" />
                    <div className="flex items-center justify-between pt-5">
                      <div className="flex gap-2">
                        <span className="h-7 w-20 rounded-lg bg-muted/45" />
                        <span className="size-7 rounded-lg bg-muted/45" />
                      </div>
                      <span className="size-8 rounded-full bg-muted/55" />
                    </div>
                  </div>
                </div>
              </div>
              <div
                aria-hidden
                className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
