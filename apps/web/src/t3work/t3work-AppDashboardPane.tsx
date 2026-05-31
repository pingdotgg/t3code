import { useEffect } from "react";
import type { ServerProvider } from "@t3tools/contracts";
import type { ProjectShellProject } from "@t3tools/project-context";
import type { ProjectKickoffThreadInput } from "~/t3work/t3work-kickoffTypes";
import type { ProjectDashboardMode } from "~/t3work/t3work-projectDashboardModeState";
import { ProjectDashboardKickoffAside } from "~/t3work/t3work-ProjectDashboardKickoffAside";
import { T3workDashboardRecipeActionProvider } from "~/t3work/t3work-dashboardRecipeActions";
import { ResizableRightSidebarLayout } from "~/t3work/t3work-ResizableRightSidebarLayout";
import { T3workDashboardRecipeViewProvider } from "~/t3work/t3work-dashboardRecipeViewContext";
import { getProjectDashboardRightSidebarCollapsedStorageKey } from "~/t3work/t3work-rightSidebarPersistence";
import type { ProjectThread } from "~/t3work/t3work-types";

export function AppDashboardPane({
  activeDashboardMode,
  project,
  projectThreads,
  activeThread,
  activeThreadId,
  providers,
  isConnected,
  onOpenThread,
  onOpenFullThread,
  onThreadKickoffConsumed,
  onRememberEmbeddedThread,
  onKickoffProjectThread,
  renderDashboard,
}: {
  activeDashboardMode: ProjectDashboardMode;
  project: ProjectShellProject;
  projectThreads: ProjectThread[];
  activeThread: ProjectThread | null;
  activeThreadId: string | null;
  providers: ReadonlyArray<ServerProvider>;
  isConnected: boolean;
  onOpenThread: (projectId: string, threadId: string) => void;
  onOpenFullThread: (projectId: string, threadId: string) => void;
  onThreadKickoffConsumed: (threadId: string) => void;
  onRememberEmbeddedThread: (threadId: string) => void;
  onKickoffProjectThread: (input: ProjectKickoffThreadInput) => void;
  renderDashboard: (project: ProjectShellProject) => React.ReactNode;
}) {
  useEffect(() => {
    if (!activeThread) {
      return;
    }

    onRememberEmbeddedThread(activeThread.id);
  }, [activeThread, onRememberEmbeddedThread]);

  return (
    <T3workDashboardRecipeViewProvider>
      <T3workDashboardRecipeActionProvider>
        <ResizableRightSidebarLayout
          storageKey="t3work_dashboard_right_sidebar"
          collapsedStorageKey={getProjectDashboardRightSidebarCollapsedStorageKey({
            projectId: project.id,
            dashboardMode: activeDashboardMode,
            embeddedThreadId: activeThreadId,
          })}
          minAsideWidth={22 * 16}
          defaultAsideWidth={24 * 16}
          mobileDefaultPanel={activeThread ? "aside" : "main"}
          mobileMainLabel={activeDashboardMode === "backlog" ? "Backlog" : "My work"}
          mobileAsideLabel={activeThread ? "Chat" : "Agent"}
          main={
            <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
              {renderDashboard(project)}
            </div>
          }
          aside={
            <ProjectDashboardKickoffAside
              project={project}
              dashboardMode={activeDashboardMode}
              projectThreads={projectThreads}
              activeThread={activeThread}
              providers={providers}
              isConnected={isConnected}
              onOpenThread={(threadId) => onOpenThread(project.id, threadId)}
              onOpenFullThread={(threadId) => onOpenFullThread(project.id, threadId)}
              onThreadKickoffConsumed={onThreadKickoffConsumed}
              onKickoffThread={(
                kickoffMessage,
                kickoffPending,
                kickoffModelSelection,
                kickoffRuntimeMode,
                kickoffInteractionMode,
                selectedToolIds,
                kickoffContextAttachments,
                kickoffWorkflow,
              ) => {
                onKickoffProjectThread({
                  projectId: project.id,
                  dashboardMode: activeDashboardMode,
                  kickoffMessage,
                  ...(kickoffPending !== undefined ? { kickoffPending } : {}),
                  kickoffModelSelection,
                  kickoffRuntimeMode,
                  kickoffInteractionMode,
                  selectedToolIds,
                  kickoffContextAttachments,
                  ...(kickoffWorkflow ? { kickoffWorkflow } : {}),
                });
              }}
            />
          }
        />
      </T3workDashboardRecipeActionProvider>
    </T3workDashboardRecipeViewProvider>
  );
}
