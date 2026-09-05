import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { LinkIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  readProjects,
  waitForProject,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments, useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import type { EnvironmentId } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";

import { isHostedStaticApp } from "../hostedPairing";
import { primaryServerConfigAtom } from "../state/server";
import { environmentShell } from "../state/shell";
import { useEnvironmentQuery } from "../state/query";
import { filesystemEnvironment } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { resolveStartupFolderProject } from "../lib/startupFolder";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedStaticOnboardingState />;
  }

  return <ConfiguredIndexLanding />;
}

function ConfiguredIndexLanding() {
  const environmentId = usePrimaryEnvironmentId();
  const config = useAtomValue(primaryServerConfigAtom);
  // Schema defaults are not the saved preference. Wait for the owning server
  // before allowing the recent-project landing to navigate to another machine.
  if (!isHostedStaticApp() && config === null) return null;
  return config?.settings.openDefaultFolderOnStartup && environmentId !== null ? (
    <StartupFolderLanding
      key={JSON.stringify([environmentId, config.settings.addProjectBaseDirectory])}
      environmentId={environmentId}
      directory={config.settings.addProjectBaseDirectory}
    />
  ) : (
    <IndexDraftLanding />
  );
}

function StartupFolderLanding({
  directory,
  environmentId,
}: {
  directory: string;
  environmentId: EnvironmentId;
}) {
  const environment = useEnvironment(environmentId);
  const shell = useEnvironmentQuery(
    environment === null ? null : environmentShell.stateAtom(environment.environmentId),
  );
  const browse = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    refresh: true,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const router = useRouter();
  const startedAttemptRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const ready =
    environment?.connection.phase === "connected" &&
    shell.data?.status === "live" &&
    shell.data.snapshot._tag === "Some";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const start = useEffectEvent(async () => {
    if (!environment) return;
    const requestingHref = router.state.location.href;
    const isCurrent = () =>
      mountedRef.current &&
      appAtomRegistry.get(primaryEnvironmentIdAtom) === environmentId &&
      router.state.location.href === requestingHref;
    try {
      const projectRef = await resolveStartupFolderProject({
        environmentId,
        directory,
        isCurrent,
        browse: async (partialPath) => {
          const result = await browse({
            environmentId,
            input: { partialPath, requireReadableDirectory: true },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        readProjects,
        createProject: async (workspaceRoot) => {
          const projectId = newProjectId();
          const result = await createProject({
            environmentId,
            input: {
              projectId,
              title: inferProjectTitleFromPath(workspaceRoot),
              workspaceRoot,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return projectId;
        },
        waitForProject,
      });
      if (projectRef === null || !isCurrent()) return;
      await openThread(projectRef, {
        replace: true,
        envMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
      });
    } catch {
      if (isCurrent()) setFailure(directory.trim() || "~/");
    }
  });

  useEffect(() => {
    if (!ready || startedAttemptRef.current === retry) return;
    startedAttemptRef.current = retry;
    void start();
  }, [ready, retry]);

  if (failure === null) return null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Couldn’t open the default folder</EmptyTitle>
          <EmptyDescription>
            Check that {failure} exists and is accessible on this environment, or change the startup
            folder in General settings.
          </EmptyDescription>
          <div className="mt-5 flex justify-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setFailure(null);
                setRetry((value) => value + 1);
              }}
            >
              Try again
            </Button>
            <Button size="sm" variant="outline" render={<Link to="/settings/general" />}>
              Open settings
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

/**
 * Landing on the index route drops straight into a draft thread for the most
 * recently active project, so the first screen is a prompt instead of a dead
 * end. Falls back to an add-project hero when no project exists yet.
 */
function IndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject = useMemo(
    () =>
      bootstrapped
        ? (sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null)
        : null,
    [bootstrapped, projects, threads],
  );

  useEffect(() => {
    if (mostRecentProject === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
      replace: true,
    }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [handleNewThread, mostRecentProject, startState.retryRequest]);

  if (!bootstrapped) {
    return null;
  }
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
  // First-run routing to the welcome wizard happens in FirstRunGate at the
  // root, before this route ever renders.
  return <NoProjectsHero />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                What should we work on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Add a project to start your first thread.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button size="sm" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  Add project
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {cloudEnabled
                  ? "Sign in to T3 Connect to connect a linked environment through its managed tunnel, or add a reachable backend manually."
                  : "Add a reachable backend manually to start working from this browser."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  {cloudEnabled ? "Open Connections" : "Add environment"}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
