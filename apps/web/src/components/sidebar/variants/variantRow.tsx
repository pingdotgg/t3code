import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { BotIcon, CircleDashedIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { observeVisibleAnimation } from "../../../lib/visibleAnimation";
import { ActivityShimmerOverlay } from "../../chat/TimelineRowParts";
import { ProjectFavicon } from "../../ProjectFavicon";
import type { SidebarThreadStatus } from "../../Sidebar.logic";
import { InlineRowAnswers, RowAnswersPopover } from "./RowAnswers";
import { rowAttention, type VariantRowStyle } from "./sidebarVariant.logic";

function PulsingDot() {
  return (
    <span
      aria-hidden
      ref={observeVisibleAnimation}
      className="sidebar-status-dot block size-1.5 shrink-0 rounded-full bg-info-foreground"
    />
  );
}

function SpinningMark() {
  return (
    <CircleDashedIcon
      aria-hidden
      ref={observeVisibleAnimation}
      className="sidebar-status-spin size-3.5 shrink-0 text-info-foreground"
    />
  );
}

function workerLabel(count: number, needsYou: boolean): string {
  return `${count} ${count === 1 ? "worker" : "workers"}${needsYou ? ", one needs you" : ""}`;
}

/** The parts a variant adds to T3's folder row; everything else stays T3's row. */
export function resolveVariantRow(input: {
  style: VariantRowStyle;
  thread: EnvironmentThreadShell;
  status: SidebarThreadStatus;
  statusWord: { label: string; className: string } | null;
  statusIcon: ReactNode;
  duration: ReactNode;
  time: ReactNode;
  isUnread: boolean;
  isActive: boolean;
  nested: boolean;
  project: Parameters<typeof ProjectFavicon>[0]["project"] | null;
  showProjectMark: boolean;
  title: ReactNode;
  titleDirection: ReturnType<typeof textDirection>;
  workerCount: number;
  workerNeedsYou: boolean;
  answersOpen: boolean;
  onAnswersOpenChange: (open: boolean) => void;
  onOpenThread: () => void;
  providerIcon: ((size: "badge" | "alone") => ReactNode) | null;
}) {
  const { style, thread, status, statusWord } = input;
  const working = status === "working" || status === "preparing";
  const asksYou = thread.hasPendingApprovals || thread.hasPendingUserInput;
  const detailed = style === "folder-detailed";
  const answersInPopover = !detailed && asksYou;

  const mark = working ? (
    detailed ? (
      <PulsingDot />
    ) : (
      <SpinningMark />
    )
  ) : (
    (input.statusIcon ??
    (input.showProjectMark && input.project ? (
      <ProjectFavicon project={input.project} className="size-4" />
    ) : null))
  );

  const speaksUp =
    status === "approval" ||
    status === "input" ||
    status === "request" ||
    status === "failed" ||
    status === "limited";

  const slot =
    answersInPopover && statusWord ? (
      <RowAnswersPopover
        thread={thread}
        label={statusWord.label}
        className={statusWord.className}
        open={input.answersOpen}
        onOpenChange={input.onAnswersOpenChange}
        onOpenThread={input.onOpenThread}
      />
    ) : (detailed || speaksUp) && statusWord ? (
      <span
        className={cn("inline-flex items-center gap-1 text-xs font-medium", statusWord.className)}
      >
        {statusWord.label}
        {detailed && working ? (
          <span aria-hidden className="inline-flex min-w-6 justify-end font-normal">
            {input.duration}
          </span>
        ) : null}
      </span>
    ) : working ? (
      <span className="inline-flex min-w-8 justify-end text-xs">{input.duration}</span>
    ) : (
      <span className="text-xs">{input.time}</span>
    );

  const attention = detailed ? rowAttention(status, input.isUnread) : undefined;

  return {
    rowClassName: cn(
      "sidebar-variant-tokens ps-9",
      detailed ? "sidebar-row-detailed py-1.5 pe-2.5" : "flex h-9 items-center gap-2.5 pe-2.5",
      input.nested && "ps-13",
    ),
    // A tinted row carries its own bar, so the guide stops at its edge and resumes after it.
    rootClassName:
      input.nested && attention === undefined
        ? "relative before:absolute before:inset-y-0 before:left-[1.0625rem] before:w-px before:bg-border"
        : undefined,
    attention,
    labelSuffix:
      input.workerCount > 0 ? `, ${workerLabel(input.workerCount, input.workerNeedsYou)}` : "",
    decor: (
      <>
        {detailed && working ? (
          <span aria-hidden ref={observeVisibleAnimation} className="sidebar-row-sweep" />
        ) : null}
        {mark !== null || input.providerIcon !== null ? (
          <span
            aria-hidden
            className={cn(
              "absolute top-2.5 size-4",
              input.nested ? "left-7" : "left-(--sidebar-row-content-inset)",
            )}
          >
            <span
              className={cn(
                "absolute inset-0 flex items-center justify-center",
                // The notch shows the row's own surface as the badge's ring, in every state.
                mark !== null &&
                  !working &&
                  input.providerIcon !== null &&
                  "sidebar-row-mark-notch",
              )}
            >
              {mark ?? (
                <span className="flex text-secondary-label">{input.providerIcon?.("alone")}</span>
              )}
            </span>
            {mark !== null && input.providerIcon !== null ? (
              <span
                data-row-provider-badge
                className="absolute top-3 left-3 flex size-2.5 items-center justify-center text-sidebar-foreground"
              >
                {input.providerIcon("badge")}
              </span>
            ) : null}
          </span>
        ) : null}
      </>
    ),
    title:
      !detailed && working && !input.isActive ? (
        <span
          ref={observeVisibleAnimation}
          className="relative flex min-w-0 flex-1 overflow-hidden"
        >
          {input.title}
          <ActivityShimmerOverlay>
            <span dir={input.titleDirection} className="block truncate text-start text-sm">
              {thread.title}
            </span>
          </ActivityShimmerOverlay>
        </span>
      ) : (
        input.title
      ),
    beforeSlot:
      input.workerCount > 0 ? (
        <span
          aria-hidden
          className={cn(
            "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums",
            input.workerNeedsYou ? "text-warning-foreground" : "text-secondary-label",
          )}
        >
          <BotIcon className="size-3" />
          {input.workerCount}
        </span>
      ) : null,
    slot,
    keepsSlot: answersInPopover,
    answers: detailed && asksYou ? <InlineRowAnswers thread={thread} /> : null,
  };
}
