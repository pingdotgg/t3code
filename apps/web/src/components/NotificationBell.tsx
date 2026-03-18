import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReviewRequest } from "@t3tools/contracts";
import { BellIcon, BotIcon, ExternalLinkIcon, GitPullRequestIcon, XIcon } from "lucide-react";

import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useSidebar } from "./ui/sidebar";
import { reviewRequestListQueryOptions } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";

type Filter = "reviews" | "bot" | "all";

const emptyRequests: ReviewRequest[] = [];

interface NotificationBellProps {
  onStartReview: (prUrl: string, requestId: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function NotificationBell({
  onStartReview,
  open: controlledOpen,
  onOpenChange,
}: NotificationBellProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (value: boolean) => {
    if (!isControlled) setInternalOpen(value);
    onOpenChange?.(value);
  };
  const [filter, setFilter] = useState<Filter>("reviews");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { isMobile, setOpenMobile } = useSidebar();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const reviewRequestsQuery = useQuery(reviewRequestListQueryOptions());

  const requests = reviewRequestsQuery.data?.reviewRequests ?? emptyRequests;

  // Badge only counts pending non-bot requests — bots don't trigger notifications
  const pendingCount = requests.filter((r) => r.status === "pending" && !r.isBot).length;

  const filteredRequests = useMemo(() => {
    const filtered =
      filter === "all"
        ? requests
        : filter === "bot"
          ? requests.filter((r) => r.isBot)
          : requests.filter((r) => !r.isBot);

    // Sort: in_review first (active work), then pending (needs attention).
    // Within each group, newest PR number first for a stable predictable order.
    const statusOrder: Record<string, number> = { in_review: 0, pending: 1 };
    return filtered.toSorted((a, b) => {
      const sa = statusOrder[a.status] ?? 2;
      const sb = statusOrder[b.status] ?? 2;
      if (sa !== sb) return sa - sb;
      return b.prNumber - a.prNumber;
    });
  }, [requests, filter]);

  const handleDismiss = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    const api = readNativeApi();
    if (!api) return;
    await api.reviewRequest.dismiss({ id });
    await queryClient.invalidateQueries({ queryKey: ["reviewRequest"] });
  };

  const handleClick = (request: ReviewRequest) => {
    setOpen(false);
    setOpenMobile(false);
    if (request.status === "in_review" && request.threadId) {
      void navigate({ to: "/$threadId", params: { threadId: request.threadId } });
    } else {
      onStartReview(request.prUrl, request.id);
    }
  };

  const botCount = requests.filter((r) => r.isBot).length;
  const reviewCount = requests.filter((r) => !r.isBot).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              className="relative inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Review requests"
            >
              <BellIcon className="size-3.5" />
              {pendingCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
                  {pendingCount > 9 ? "9+" : pendingCount}
                </span>
              )}
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="bottom">Review requests</TooltipPopup>
      </Tooltip>

      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={8}
        positionerClassName="max-sm:z-[52]"
        className="max-sm:w-[calc(100vw-1rem)] sm:w-96"
      >
        <div className="-my-4 -mx-4">
          <div className="border-b border-border/50 px-3 py-2">
            <div className="flex items-center gap-1">
              <FilterTab
                active={filter === "reviews"}
                onClick={() => setFilter("reviews")}
                count={reviewCount}
              >
                Reviews
              </FilterTab>
              <FilterTab
                active={filter === "bot"}
                onClick={() => setFilter("bot")}
                count={botCount}
              >
                <BotIcon className="size-3" />
                Bot
              </FilterTab>
              <FilterTab
                active={filter === "all"}
                onClick={() => setFilter("all")}
                count={requests.length}
              >
                All
              </FilterTab>
            </div>
          </div>

          {filteredRequests.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground/60">
              {filter === "bot"
                ? "No bot PRs"
                : filter === "reviews"
                  ? "No review requests"
                  : "No review requests"}
            </div>
          ) : (
            <div className="max-h-[70dvh] overflow-y-auto sm:max-h-[500px]">
              {filteredRequests.map((request, index) => {
                const isExpanded = expandedId === request.id;
                const prevStatus = index > 0 ? filteredRequests[index - 1]!.status : null;
                const showGroupLabel = request.status !== prevStatus;
                return (
                  <div
                    key={request.id}
                    ref={isExpanded ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  >
                    {showGroupLabel && (
                      <div className="sticky top-0 z-10 border-b border-border/30 bg-popover/95 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50 backdrop-blur-sm">
                        {request.status === "in_review" ? "In progress" : "Awaiting review"}
                      </div>
                    )}
                    <div
                      role="button"
                      tabIndex={0}
                      className={`group/item flex w-full items-start gap-2 border-b border-border/30 px-3 text-left transition-[background-color,padding] duration-150 ease-out hover:bg-accent/50 ${isExpanded ? "bg-accent/30 py-3" : "py-2.5"}`}
                      onClick={() =>
                        setExpandedId((prev) => (prev === request.id ? null : request.id))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpandedId((prev) => (prev === request.id ? null : request.id));
                        }
                      }}
                    >
                      <GitPullRequestIcon
                        className={`mt-0.5 size-3.5 shrink-0 ${
                          request.status === "in_review" ? "text-violet-500" : "text-emerald-500"
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs text-muted-foreground/60">
                            {request.repoNameWithOwner}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground/60">
                            #{request.prNumber}
                          </span>
                          {request.isBot && (
                            <BotIcon className="size-3 shrink-0 text-muted-foreground/50" />
                          )}
                        </div>
                        <p
                          className={`mt-0.5 text-xs font-medium transition-colors duration-150 ${
                            isExpanded
                              ? "line-clamp-3 text-foreground/90"
                              : "truncate text-foreground/80"
                          }`}
                        >
                          {request.prTitle}
                        </p>
                        <span className="mt-0.5 block text-[10px] text-muted-foreground/50">
                          by {request.authorLogin}
                        </span>
                        {/* Action buttons — animated reveal via CSS grid height trick */}
                        <div
                          className={`grid transition-[grid-template-rows,opacity] duration-150 ease-out ${
                            isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                          }`}
                        >
                          <div className="overflow-hidden">
                            {request.prBody && (
                              <p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground/60">
                                {request.prBody}
                              </p>
                            )}
                            {request.prLabels && request.prLabels.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {request.prLabels.map((label) => (
                                  <span
                                    key={label}
                                    className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground/80"
                                  >
                                    {label}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="flex items-center gap-2 pt-2">
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-violet-500"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleClick(request);
                                }}
                              >
                                <ExternalLinkIcon className="size-3" />
                                {request.status === "in_review" && request.threadId
                                  ? "Go to Review"
                                  : "Start Review"}
                              </button>
                              {request.status === "in_review" && (
                                <button
                                  type="button"
                                  className="rounded-md border border-border/50 px-2 py-1 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
                                  onClick={(event) => void handleDismiss(event, request.id)}
                                >
                                  Done
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover/item:opacity-100"
                        aria-label="Dismiss"
                        onClick={(event) => void handleDismiss(event, request.id)}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PopoverPopup>
      {open &&
        isMobile &&
        createPortal(
          <div
            className="fixed inset-0 z-[51] touch-none"
            aria-hidden
            onClick={() => setOpen(false)}
          />,
          document.body,
        )}
    </Popover>
  );
}

function FilterTab({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground/60 hover:text-muted-foreground"
      }`}
      onClick={onClick}
    >
      {children}
      {count > 0 && (
        <span
          className={`ml-0.5 text-[9px] ${active ? "text-foreground/70" : "text-muted-foreground/40"}`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
