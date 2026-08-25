/**
 * The report a conversation is about, shown above its messages. It leads with
 * the verdict (what the report asks of the reader), then the summary in its
 * labeled slots, then the evidence and code the agent already gathered.
 *
 * Collapsed once the conversation has messages: by then the reader has read it.
 */
import {
  postHogReportUrl,
  type EnvironmentId,
  type PostHogReport,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  InboxIcon,
  MessagesSquareIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { cn } from "../../lib/utils";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useReportSeenStore } from "../../reportSeenStore";
import { useProjects, useThreadShells } from "../../state/entities";
import { postHogEnvironment, reportsListAtom } from "../../state/posthog";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { ThreadShell } from "../../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { readReportArtefacts } from "./reportArtefacts";
import { deriveReportVerdict, splitReportSummary, type ReportVerdictTone } from "./reportVerdict";
import { usePostHogQuery } from "./reportsQuery";
import { reportThreads, useReportOpener } from "./useOpenReport";

const VERDICT_TONE_CLASS: Readonly<Record<ReportVerdictTone, string>> = {
  decision: "border-amber-500/40 bg-amber-500/10",
  progress: "border-sky-500/40 bg-sky-500/10",
  info: "border-border bg-muted/40",
  danger: "border-destructive/40 bg-destructive/10",
};

function Chip({ children }: { readonly children: React.ReactNode }) {
  return (
    <Badge size="sm" variant="secondary" className="rounded-full px-1.5 font-normal">
      {children}
    </Badge>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function formatDollarValue(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * Mounted by the chat view when its thread is about a report. Keeps its own
 * queries so the chat view does not have to know about PostHog.
 */
export function ReportHeader({
  environmentId,
  reportId,
  threadId,
  threadHasMessages,
  onOpenTerminal,
}: {
  readonly environmentId: EnvironmentId;
  readonly reportId: string;
  readonly threadId: ThreadId;
  readonly threadHasMessages: boolean;
  readonly onOpenTerminal: () => void;
}) {
  const reportsQuery = usePostHogQuery(reportsListAtom(environmentId));
  const report = useMemo(
    () => reportsQuery.data?.reports.find((entry) => entry.id === reportId) ?? null,
    [reportId, reportsQuery.data],
  );
  const markSeen = useReportSeenStore((state) => state.markSeen);

  useEffect(() => {
    if (report === null) return;
    markSeen(report.id, report.updated_at);
  }, [markSeen, report]);

  useBackToInboxShortcut();

  const [expanded, setExpanded] = useState(!threadHasMessages);
  // The thread starts empty and fills as the conversation runs; the header
  // folds itself away once there is something to read below it.
  useEffect(() => {
    if (threadHasMessages) setExpanded(false);
  }, [threadHasMessages]);

  if (report === null) {
    return (
      <div className="border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        {reportsQuery.isPending ? "Loading the report…" : "This report is no longer available."}
      </div>
    );
  }

  return (
    <ReportHeaderBody
      environmentId={environmentId}
      report={report}
      threadId={threadId}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      onOpenTerminal={onOpenTerminal}
    />
  );
}

function ReportHeaderBody({
  environmentId,
  report,
  threadId,
  expanded,
  onToggle,
  onOpenTerminal,
}: {
  readonly environmentId: EnvironmentId;
  readonly report: PostHogReport;
  readonly threadId: ThreadId;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenTerminal: () => void;
}) {
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const artefactsQuery = useEnvironmentQuery(
    postHogEnvironment.artefacts({ environmentId, input: { reportId: report.id } }),
  );
  const artefacts = useMemo(
    () => readReportArtefacts(artefactsQuery.data?.artefacts ?? []),
    [artefactsQuery.data],
  );
  const threads = useReportThreadsForReport(report.id);
  const hasExistingPr =
    Boolean(report.implementation_pr_url) ||
    threads.some((thread) => thread.linkedPullRequest != null);
  const verdict = deriveReportVerdict(report, { hasExistingPr });
  const summary = useMemo(() => splitReportSummary(report.summary), [report.summary]);
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const project = useReportThreadProject(threadId);
  const worktreePath = useReportThreadWorktreePath(threadId);
  const reportUrl = postHogReportUrl({
    host: serverSettings.posthog.host,
    projectId: serverSettings.posthog.projectId,
    reportId: report.id,
  });

  return (
    <div className="shrink-0 border-b border-border/60 bg-background/60">
      <div className="flex flex-col gap-2 px-4 pb-3 pt-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link
            to="/inbox"
            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:text-foreground"
          >
            <InboxIcon className="size-3.5" />
            Inbox
          </Link>
          <span aria-hidden>·</span>
          {report.priority ? <Chip>{report.priority}</Chip> : null}
          {artefacts.priority?.dollar_value != null ? (
            <Chip>{formatDollarValue(artefacts.priority.dollar_value)}</Chip>
          ) : null}
          <Chip>{report.status.replace(/_/g, " ")}</Chip>
          {artefacts.repoSelection?.repository ? (
            <Chip>{artefacts.repoSelection.repository}</Chip>
          ) : null}
          <span className="tabular-nums">{formatRelativeTimeLabel(report.updated_at)}</span>
          <div className="ms-auto flex items-center gap-1">
            <ConversationsMenu
              environmentId={environmentId}
              report={report}
              threads={threads}
              currentThreadId={threadId}
            />
            <a
              href={reportUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:text-foreground"
            >
              <ExternalLinkIcon className="size-3.5" />
              PostHog
            </a>
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
            <Button size="icon-micro" variant="ghost" aria-label="Toggle report" onClick={onToggle}>
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
              />
            </Button>
          </div>
        </div>

        <h2 className="text-base font-semibold leading-snug">{report.title}</h2>

        <p className={cn("rounded-lg border px-3 py-2 text-sm", VERDICT_TONE_CLASS[verdict.tone])}>
          <span className="font-medium">{verdict.title}.</span>{" "}
          <span className="text-muted-foreground">{verdict.body}</span>
        </p>

        {expanded ? (
          <div className="space-y-4 pt-1 text-sm">
            {summary.lede ? <p className="whitespace-pre-wrap">{summary.lede}</p> : null}
            {summary.sections.length === 0 && !summary.lede && report.summary ? (
              <p className="whitespace-pre-wrap">{report.summary}</p>
            ) : null}
            {summary.sections.map((section) => (
              <Section key={section.title} title={section.title}>
                <p className="whitespace-pre-wrap">{section.body}</p>
              </Section>
            ))}

            {artefacts.findings.length > 0 ? (
              <Section title="Evidence">
                <ul className="space-y-2">
                  {artefacts.findings.map(({ id, value: finding }) => (
                    <li key={id} className="space-y-0.5">
                      <p className="text-xs">
                        <span className="font-mono">{finding.signal_id}</span>
                        {finding.verified ? " · verified" : ""}
                      </p>
                      {finding.relevant_code_paths.length > 0 ? (
                        <p className="font-mono text-xs text-muted-foreground">
                          {finding.relevant_code_paths.join(", ")}
                        </p>
                      ) : null}
                      {Object.entries(finding.relevant_commit_hashes).map(([hash, note]) => (
                        <p key={hash} className="text-xs text-muted-foreground">
                          <span className="font-mono">{hash}</span>: {note}
                        </p>
                      ))}
                      {finding.data_queried ? (
                        <p className="text-xs text-muted-foreground">
                          Data: {finding.data_queried}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {artefacts.codeReferences.length > 0 ? (
              <Section title="Code">
                <ul className="space-y-2">
                  {artefacts.codeReferences.map(({ id, value: reference }) => (
                    <li key={id} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">
                          {reference.file_path}:L{reference.start_line}-{reference.end_line}
                        </span>
                        {project ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            // The editor RPC opens a directory, not a file, so
                            // this lands the reader in the repository.
                            onClick={() => void openInPreferredEditor(project.workspaceRoot)}
                          >
                            Open in editor
                          </Button>
                        ) : null}
                      </div>
                      {reference.relevance_note ? (
                        <p className="text-xs text-muted-foreground">{reference.relevance_note}</p>
                      ) : null}
                      <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
                        {reference.contents}
                      </pre>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {artefacts.reviewers.length > 0 ? (
              <Section title="Suggested reviewers">
                <p className="text-xs text-muted-foreground">
                  {artefacts.reviewers
                    .map(
                      (reviewer) =>
                        `@${reviewer.github_login}${reviewer.reason ? ` (${reviewer.reason})` : ""}`,
                    )
                    .join(", ")}
                </p>
              </Section>
            ) : null}

            {artefactsQuery.isPending ? (
              <p className="text-xs text-muted-foreground">Loading evidence…</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConversationsMenu({
  environmentId,
  report,
  threads,
  currentThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly report: PostHogReport;
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly currentThreadId: ThreadId;
}) {
  const navigate = useNavigate();
  const { openReport } = useReportOpener(environmentId);
  const openPrLink = useOpenPrLink();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="xs" variant="ghost">
            <MessagesSquareIcon className="size-3.5" />
            {threads.length > 1 ? threads.length : null}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {threads.map((thread) => (
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
            {thread.linkedPullRequest ? (
              <button
                type="button"
                className="text-xs tabular-nums text-muted-foreground underline"
                onClick={(event) => {
                  const url = thread.linkedPullRequest?.url;
                  if (url) openPrLink(event, url);
                }}
              >
                #{thread.linkedPullRequest.number}
              </button>
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={() => openReport(report, { forceNew: true })}>
          <PlusIcon className="size-3.5" />
          New conversation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useReportThreadsForReport(reportId: string): ReadonlyArray<ThreadShell> {
  const threads = useThreadShells();
  return useMemo(() => reportThreads(threads, reportId), [reportId, threads]);
}

function useReportThreadProject(threadId: ThreadId) {
  const threads = useThreadShells();
  const projects = useProjects();
  return useMemo(() => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) return null;
    return (
      projects.find(
        (project) =>
          project.id === thread.projectId && project.environmentId === thread.environmentId,
      ) ?? null
    );
  }, [projects, threadId, threads]);
}

function useReportThreadWorktreePath(threadId: ThreadId): string | null {
  const threads = useThreadShells();
  return useMemo(
    () => threads.find((candidate) => candidate.id === threadId)?.worktreePath ?? null,
    [threadId, threads],
  );
}

/**
 * `u` goes back to the inbox, the way it does in a mail client. Only while
 * nothing is focused: once the reader is in the composer, `u` is a letter.
 */
function useBackToInboxShortcut(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "u" || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (event.target !== document.body) return;
      event.preventDefault();
      void navigate({ to: "/inbox" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}
