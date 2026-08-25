/**
 * Reports-first sidebar: PostHog reports are the top-level rows, with the
 * threads implementing each report nested underneath. Threads without a
 * report and project management sit in collapsed sections at the bottom.
 */
import type { EnvironmentId, PostHogReport, ThreadId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, FolderPlusIcon, PlugIcon, SettingsIcon } from "lucide-react";
import { memo, useCallback, useMemo, type ReactNode } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useProjects, useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { reportSectionForStatus, reportsListAtom, type ReportSection } from "../state/posthog";
import type { ThreadShell } from "../types";
import { usePostHogQuery, type PostHogQueryError } from "./reports/reportsQuery";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Badge } from "./ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";

const REPORT_SECTIONS: ReadonlyArray<{ readonly id: ReportSection; readonly label: string }> = [
  { id: "needs-you", label: "Needs you" },
  { id: "in-progress", label: "In progress" },
  { id: "candidates", label: "Candidates" },
  { id: "archived", label: "Archived" },
];

const STATUS_DOT_CLASS: Record<SidebarThreadStatus, string | null> = {
  working: "bg-sky-500",
  monitoring: "bg-sky-500/60",
  approval: "bg-amber-500",
  input: "bg-indigo-500",
  failed: "bg-red-500",
  ready: null,
};

function useCloseMobileSidebar(): () => void {
  const { isMobile, setOpenMobile } = useSidebar();
  return useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
}

function SectionLabel({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarGroupLabel className="h-7 px-2 text-[11px] uppercase tracking-wide text-sidebar-muted-foreground">
      {children}
    </SidebarGroupLabel>
  );
}

function CollapsedSection({
  label,
  count,
  children,
}: {
  readonly label: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible className="group/section">
      <CollapsibleTrigger className="flex h-7 w-full items-center gap-1 rounded-lg px-2 text-[11px] font-medium uppercase tracking-wide text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-open/section:rotate-90" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <span className="tabular-nums">{count}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>{children}</CollapsiblePanel>
    </Collapsible>
  );
}

const ThreadSubRow = memo(function ThreadSubRow({
  thread,
  isActive,
  onOpen,
}: {
  readonly thread: ThreadShell;
  readonly isActive: boolean;
  readonly onOpen: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const dotClass = STATUS_DOT_CLASS[resolveSidebarThreadStatus(thread)];
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        render={<button type="button" />}
        isActive={isActive}
        onClick={() => onOpen(thread.environmentId, thread.id)}
        title={thread.title}
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", dotClass ?? "bg-sidebar-border")}
        />
        <span>{thread.title}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});

function ThreadSubList({
  threads,
  activeThreadPath,
  onOpen,
}: {
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly activeThreadPath: string;
  readonly onOpen: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <SidebarMenuSub className="gap-0">
      {threads.map((thread) => (
        <ThreadSubRow
          key={`${thread.environmentId}:${thread.id}`}
          thread={thread}
          isActive={activeThreadPath === `/${thread.environmentId}/${thread.id}`}
          onOpen={onOpen}
        />
      ))}
    </SidebarMenuSub>
  );
}

const ReportRow = memo(function ReportRow({
  report,
  threads,
  isActive,
  activeThreadPath,
  onOpenReport,
  onOpenThread,
}: {
  readonly report: PostHogReport;
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly isActive: boolean;
  readonly activeThreadPath: string;
  readonly onOpenReport: (reportId: string) => void;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={() => onOpenReport(report.id)}
        title={report.title}
        className="h-auto min-h-8 items-start py-1.5"
      >
        <span className="min-w-0 flex-1 whitespace-normal leading-snug wrap-anywhere">
          {report.title}
        </span>
        {report.priority ? (
          <Badge size="sm" variant="secondary" className="shrink-0 rounded-full px-1.5">
            {report.priority}
          </Badge>
        ) : null}
      </SidebarMenuButton>
      <ThreadSubList threads={threads} activeThreadPath={activeThreadPath} onOpen={onOpenThread} />
    </SidebarMenuItem>
  );
});

function ReportsErrorRow({ error }: { readonly error: PostHogQueryError }) {
  const navigate = useNavigate();
  const closeMobile = useCloseMobileSidebar();
  const label =
    error.tag === "not-configured"
      ? "Connect PostHog"
      : error.tag === "unauthorized"
        ? "PostHog rejected the API key"
        : "PostHog request failed";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => {
            closeMobile();
            void navigate({ to: "/settings/integrations" });
          }}
          title={error.tag === "other" ? error.message : undefined}
        >
          {error.tag === "not-configured" ? <PlugIcon /> : <SettingsIcon />}
          <span>{label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ReportsSections({
  environmentId,
  threadsByReportId,
  activeThreadPath,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadsByReportId: ReadonlyMap<string, ReadonlyArray<ThreadShell>>;
  readonly activeThreadPath: string;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const navigate = useNavigate();
  const closeMobile = useCloseMobileSidebar();
  const reportsQuery = usePostHogQuery(reportsListAtom(environmentId));
  const selectedReportId = useLocation({
    select: (location) =>
      location.pathname === "/reports"
        ? ((location.search as { readonly reportId?: string }).reportId ?? null)
        : null,
  });
  const onOpenReport = useCallback(
    (reportId: string) => {
      closeMobile();
      void navigate({ to: "/reports", search: { reportId } });
    },
    [closeMobile, navigate],
  );
  const sections = useMemo(() => {
    const bySection = new Map<ReportSection, PostHogReport[]>();
    for (const report of reportsQuery.data?.reports ?? []) {
      const section = reportSectionForStatus(report.status);
      const list = bySection.get(section);
      if (list) list.push(report);
      else bySection.set(section, [report]);
    }
    return REPORT_SECTIONS.map((section) => ({
      ...section,
      reports: bySection.get(section.id) ?? [],
    }));
  }, [reportsQuery.data]);

  if (reportsQuery.error) {
    return <ReportsErrorRow error={reportsQuery.error} />;
  }
  const total = sections.reduce((sum, section) => sum + section.reports.length, 0);
  if (total === 0) {
    return (
      <p className="px-2 py-4 text-center text-xs text-muted-foreground/60">
        {reportsQuery.isPending ? "Loading reports…" : "No reports yet"}
      </p>
    );
  }
  const renderRows = (reports: ReadonlyArray<PostHogReport>) => (
    <SidebarMenu className="gap-0">
      {reports.map((report) => (
        <ReportRow
          key={report.id}
          report={report}
          threads={threadsByReportId.get(report.id) ?? []}
          isActive={selectedReportId === report.id}
          activeThreadPath={activeThreadPath}
          onOpenReport={onOpenReport}
          onOpenThread={onOpenThread}
        />
      ))}
    </SidebarMenu>
  );
  return (
    <>
      {sections.map((section) =>
        section.reports.length === 0 ? null : section.id === "archived" ? (
          <CollapsedSection key={section.id} label={section.label} count={section.reports.length}>
            {renderRows(section.reports)}
          </CollapsedSection>
        ) : (
          <div key={section.id} className="flex flex-col">
            <SectionLabel>{section.label}</SectionLabel>
            {renderRows(section.reports)}
          </div>
        ),
      )}
    </>
  );
}

export default function ReportsSidebar() {
  const navigate = useNavigate();
  const closeMobile = useCloseMobileSidebar();
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const threads = useThreadShells();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const activeThreadPath = useLocation({ select: (location) => location.pathname });

  const onOpenThread = useCallback(
    (threadEnvironmentId: EnvironmentId, threadId: ThreadId) => {
      closeMobile();
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadEnvironmentId, threadId },
      });
    },
    [closeMobile, navigate],
  );

  const { threadsByReportId, otherThreads } = useMemo(() => {
    const byReport = new Map<string, ThreadShell[]>();
    const other: ThreadShell[] = [];
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      if (thread.reportId) {
        const list = byReport.get(thread.reportId);
        if (list) list.push(thread);
        else byReport.set(thread.reportId, [thread]);
      } else {
        other.push(thread);
      }
    }
    return { threadsByReportId: byReport, otherThreads: other };
  }, [threads]);

  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId: environmentId,
        resolveEnvironmentLabel: () => null,
      }),
    [environmentId, projectGroupingSettings, projects],
  );

  const otherThreadsByProject = useMemo(
    () =>
      projectGroups
        .map((group) => {
          const memberKeys = new Set(
            group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
          );
          return {
            group,
            threads: otherThreads.filter((thread) =>
              memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
            ),
          };
        })
        .filter((entry) => entry.threads.length > 0),
    [otherThreads, projectGroups],
  );

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
        <SidebarGroup className="gap-1 pb-1">
          {environmentId === null ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground/60">
              Connect a server to see reports.
            </p>
          ) : (
            <ReportsSections
              environmentId={environmentId}
              threadsByReportId={threadsByReportId}
              activeThreadPath={activeThreadPath}
              onOpenThread={onOpenThread}
            />
          )}
        </SidebarGroup>
        <SidebarGroup className="mt-auto gap-1 pt-1">
          {otherThreads.length > 0 ? (
            <CollapsedSection label="Other threads" count={otherThreads.length}>
              {otherThreadsByProject.map(({ group, threads: groupThreads }) => (
                <div key={group.projectKey} className="flex flex-col">
                  <span className="truncate px-2 py-1 text-xs text-sidebar-muted-foreground">
                    {group.displayName}
                  </span>
                  <ThreadSubList
                    threads={groupThreads}
                    activeThreadPath={activeThreadPath}
                    onOpen={onOpenThread}
                  />
                </div>
              ))}
            </CollapsedSection>
          ) : null}
          <CollapsedSection label="Repositories" count={projectGroups.length}>
            <SidebarMenu className="gap-0">
              {projectGroups.map((group) => (
                <SidebarMenuItem key={group.projectKey}>
                  <SidebarMenuButton
                    size="sm"
                    title={group.workspaceRoot}
                    onClick={() => {
                      closeMobile();
                      void navigate({
                        to: "/projects/$projectKey",
                        params: { projectKey: group.projectKey },
                      });
                    }}
                  >
                    <span>{group.displayName}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  onClick={() => openCommandPalette({ open: "add-project" })}
                >
                  <FolderPlusIcon />
                  <span>Add repository</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </CollapsedSection>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
