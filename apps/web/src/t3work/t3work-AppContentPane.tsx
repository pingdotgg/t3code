import { SidebarInset, useSidebar } from "~/t3work/components/ui/t3work-sidebar";
import { isElectron } from "~/env";
import { useProjectStore } from "~/t3work/hooks/t3work-useProjectStore";
import { AppMainContent } from "~/t3work/t3work-AppMainContent";
import { T3workInlineRecipeLaunchProvider } from "~/t3work/t3work-inlineRecipeLaunch";
import { ProjectDashboard } from "~/t3work/t3work-ProjectDashboard";
import { TicketDetailView } from "~/t3work/t3work-TicketDetailView";
import type { ProjectDashboardMode } from "~/t3work/t3work-projectDashboardModeState";
import type { ProjectThreadDisplayMode, ViewState } from "~/t3work/t3work-types";

export function AppContentPane({
  activeDashboardMode,
  resolvedView,
  store,
  reopenInitialSetup = false,
  onCreate,
  onOpenTicket,
  onOpenThread,
  onOpenFullThread,
  onOpenEmbeddedThread,
  onKickoffProjectThread,
  onKickoffTicketThread,
  onThreadKickoffConsumed,
  onThreadDisplayModeChange,
  onBackToDashboard,
  onManageRepositories,
}: {
  activeDashboardMode: ProjectDashboardMode;
  resolvedView: ViewState | null;
  store: ReturnType<typeof useProjectStore>;
  reopenInitialSetup?: boolean;
  onCreate: () => void;
  onOpenTicket: (projectId: string, ticketId: string) => void;
  onOpenThread: (projectId: string, threadId: string) => void;
  onOpenFullThread: (projectId: string, threadId: string) => void;
  onOpenEmbeddedThread: (projectId: string, threadId: string) => void;
  onKickoffProjectThread: Parameters<typeof AppMainContent>[0]["onKickoffProjectThread"];
  onKickoffTicketThread: Parameters<typeof AppMainContent>[0]["onKickoffTicketThread"];
  onThreadKickoffConsumed: (threadId: string) => void;
  onThreadDisplayModeChange: (threadId: string, displayMode: ProjectThreadDisplayMode) => void;
  onBackToDashboard: (projectId: string) => void;
  onManageRepositories: (projectId: string | null) => void;
}) {
  const { isMobile, open } = useSidebar();
  const shouldInsetDesktopHeader = isElectron && !isMobile && !open;

  return (
    <T3workInlineRecipeLaunchProvider>
      <SidebarInset className="h-full min-h-0 overflow-hidden bg-background text-foreground">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <AppMainContent
            view={resolvedView}
            activeDashboardMode={activeDashboardMode}
            selectedProjectId={store.selectedProjectId}
            projects={store.projects}
            allProjects={store.allProjects}
            reopenInitialSetup={reopenInitialSetup}
            shouldInsetDesktopHeader={shouldInsetDesktopHeader}
            getThreadsForProject={store.getThreadsForProject}
            onOpenTicket={onOpenTicket}
            onOpenThread={onOpenThread}
            onOpenFullThread={onOpenFullThread}
            onOpenEmbeddedThread={onOpenEmbeddedThread}
            onKickoffProjectThread={onKickoffProjectThread}
            onKickoffTicketThread={onKickoffTicketThread}
            onThreadKickoffConsumed={onThreadKickoffConsumed}
            onThreadDisplayModeChange={onThreadDisplayModeChange}
            onBackToDashboard={onBackToDashboard}
            onCreate={onCreate}
            onInlineProjectCreated={(project) => {
              store.addProject(project);
              onBackToDashboard(project.id);
            }}
            renderDashboard={(project) => (
              <ProjectDashboard
                project={project}
                tickets={[]}
                shouldInsetDesktopHeader={shouldInsetDesktopHeader}
                onOpenTicket={onOpenTicket}
                onManageRepositories={onManageRepositories}
              />
            )}
            renderTicketDetail={(project, ticketId, activeThreadId) => (
              <TicketDetailView
                project={project}
                ticketId={ticketId}
                shouldInsetDesktopHeader={shouldInsetDesktopHeader}
                {...(activeThreadId ? { activeThreadId } : {})}
                projectThreads={store.getThreadsForProject(project.id)}
                onOpenTicket={onOpenTicket}
                onOpenThread={onOpenThread}
                onOpenFullThread={onOpenFullThread}
                onKickoffThread={onKickoffTicketThread}
                onThreadKickoffConsumed={onThreadKickoffConsumed}
                onRememberEmbeddedThread={(threadId) =>
                  onThreadDisplayModeChange(threadId, "embedded")
                }
                onBack={() => onBackToDashboard(project.id)}
              />
            )}
          />
        </div>
      </SidebarInset>
    </T3workInlineRecipeLaunchProvider>
  );
}
