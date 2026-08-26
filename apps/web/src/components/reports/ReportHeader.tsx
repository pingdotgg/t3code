/**
 * The bar above a conversation that is about a report: what it is about, and
 * the way back to it.
 *
 * Deliberately thin. The report has its own page now, so duplicating the
 * document above the timeline would only compete with it for height — and an
 * expandable copy is what made the old chat view feel like two screens
 * fighting over one.
 */
import { postHogReportUrl, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  MessagesSquareIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useMemo } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { cn } from "../../lib/utils";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useReportSeenStore } from "../../reportSeenStore";
import { useThreadShells } from "../../state/entities";
import { reportsListAtom } from "../../state/posthog";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { ThreadShell } from "../../types";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { humanizeReportTitle } from "../inbox/inboxList.logic";
import { PriorityChip } from "./PriorityChip";
import { usePostHogQuery } from "./reportsQuery";
import { reportThreads, useReportOpener } from "./useOpenReport";

/**
 * Mounted by the chat view when its thread is about a report. Keeps its own
 * queries so the chat view does not have to know about PostHog.
 */
export function ReportHeader({
  environmentId,
  reportId,
  threadId,
  onOpenTerminal,
}: {
  readonly environmentId: EnvironmentId;
  readonly reportId: string;
  readonly threadId: ThreadId;
  readonly onOpenTerminal: () => void;
}) {
  const reportsQuery = usePostHogQuery(reportsListAtom(environmentId));
  const report = useMemo(
    () => reportsQuery.data?.reports.find((entry) => entry.id === reportId) ?? null,
    [reportId, reportsQuery.data],
  );
  const markSeen = useReportSeenStore((state) => state.markSeen);
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const threads = useThreadShells();
  const conversations = useMemo(() => reportThreads(threads, reportId), [reportId, threads]);
  const worktreePath = threads.find((candidate) => candidate.id === threadId)?.worktreePath ?? null;

  useEffect(() => {
    if (report === null) return;
    markSeen(report.id, report.updated_at);
  }, [markSeen, report]);

  useBackToReportShortcut(reportId);

  if (report === null) {
    return (
      <div className="shrink-0 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        {reportsQuery.isPending ? "Loading the report…" : "This report is no longer available."}
      </div>
    );
  }

  const reportUrl = postHogReportUrl({
    host: serverSettings.posthog.host,
    projectId: serverSettings.posthog.projectId,
    reportId: report.id,
  });

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-background/60 px-3 py-1.5 text-xs">
      <Link
        to="/inbox/$reportId"
        params={{ reportId: report.id }}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-[var(--control-radius)] px-1 py-0.5 text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-3.5 shrink-0" />
        <span className="truncate">{humanizeReportTitle(report.title)}</span>
      </Link>
      {report.priority ? <PriorityChip priority={report.priority} className="shrink-0" /> : null}

      <div className="ms-auto flex shrink-0 items-center gap-1">
        <ConversationsMenu
          environmentId={environmentId}
          reportId={report.id}
          conversations={conversations}
          currentThreadId={threadId}
        />
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label="Open in PostHog"
          render={<a href={reportUrl} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
        {worktreePath ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-micro" variant="ghost" aria-label="Worktree actions">
                  <EllipsisIcon className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void openInPreferredEditor(worktreePath)}>
                Open worktree in editor
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenTerminal}>Open terminal</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

function ConversationsMenu({
  environmentId,
  reportId,
  conversations,
  currentThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly reportId: string;
  readonly conversations: ReadonlyArray<ThreadShell>;
  readonly currentThreadId: ThreadId;
}) {
  const navigate = useNavigate();
  const { openReport } = useReportOpener(environmentId);
  const reportsQuery = usePostHogQuery(reportsListAtom(environmentId));
  const report = reportsQuery.data?.reports.find((entry) => entry.id === reportId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="xs" variant="ghost">
            <MessagesSquareIcon className="size-3.5" />
            {conversations.length > 1 ? conversations.length : null}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {conversations.map((thread) => (
          <DropdownMenuItem
            key={thread.id}
            disabled={thread.id === currentThreadId}
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              })
            }
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                thread.session?.status === "running" ? "bg-sky-500" : "bg-border",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          </DropdownMenuItem>
        ))}
        {report ? (
          <DropdownMenuItem onClick={() => openReport(report, { forceNew: true })}>
            <PlusIcon className="size-3.5" />
            New conversation
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * `u` goes up a level: from a conversation back to the report it is about.
 * The report's own page sends `u` on to the inbox, so the key walks the
 * hierarchy the way it does in a mail client.
 */
function useBackToReportShortcut(reportId: string): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "u" || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
      ) {
        return;
      }
      event.preventDefault();
      void navigate({ to: "/inbox/$reportId", params: { reportId } });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, reportId]);
}
