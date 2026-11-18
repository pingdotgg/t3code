import { workspaceAreaProps } from "../lib/workspaceFocus";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { resolveIndexLandingProject } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { resolveSidebarProjectScope } from "../sidebarProjectGrouping";
import {
  readProject,
  useAllEnvironmentProjectSnapshotsReady,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useVisibleThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { environmentProjects } from "../state/projects";
import { useWindowProjectScopeStore } from "../windowProjectScope";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <IndexDraftLanding />;
}

function IndexDraftLanding() {
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const router = useRouter();
  // Read at effect time; this page can stay mounted while the router is already navigating away.
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const startedAttemptRef = useRef<number | null>(null);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const projectGroups = useSidebarProjectGroups();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const scopeKeys = useWindowProjectScopeStore((store) => store.projectScopeKeys);
  const projectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const projectConfigsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  const scopeReady = projectSnapshotsReady && projectConfigsReady;

  const mostRecentProject = resolveIndexLandingProject({
    projects,
    threads,
    scopeKeys,
    scopedProjectKeys: resolveSidebarProjectScope({
      groups: projectGroups,
      keys: scopeKeys,
      settings: projectGroupingSettings,
      canClearMissingScope: scopeReady,
    }).memberProjectKeys,
    scopeReady,
  });
  const attempt = startState.retryRequest;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a draft thread in the most recent project and navigates to it while still on the index
  useEffect(() => {
    // Starting a draft after the user has left would replace the page they picked.
    if (mostRecentProject === null || startedAttemptRef.current === attempt || !isStillOnIndex()) {
      return;
    }
    const projectRef = scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id);
    if (readProject(projectRef) === null) {
      return;
    }
    startedAttemptRef.current = attempt;
    void handleNewThread(projectRef, { replace: true })
      .then((opened) => {
        if (opened === null) {
          setStartState((state) => ({ ...state, retryRequest: state.retryRequest + 1 }));
        }
      })
      .catch(() => {
        setStartState((state) => ({ ...state, failed: true }));
      });
  }, [attempt, handleNewThread, mostRecentProject]);

  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // A pending environment or an unresolved scope cannot prove the workspace is empty.
  return bootstrapped && (scopeKeys.length === 0 || scopeReady) ? <NoProjectsHero /> : null;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  const gt = useGT();
  const contentArea = workspaceAreaProps("home", 1, gt("Home", { $context: "the home screen" }));
  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>
            <T>Couldn’t start a new thread</T>
          </EmptyTitle>
          <EmptyDescription>
            <T>The project is still available. Try opening the draft again.</T>
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              <T>Try again</T>
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
