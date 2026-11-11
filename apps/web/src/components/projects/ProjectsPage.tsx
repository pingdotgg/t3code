import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ensureProjectCoordinator } from "./openProjectCoordinator";
import {
  COORDINATOR_THREAD_TAG,
  findProjectCoordinator,
  PROJECT_INSTRUCTIONS_PATH,
  projectAgentThreads,
  projectThreadActivity,
  resolveCoordinatorModelSelection,
} from "./projectCoordinator.logic";
import {
  ProjectInstructionsDialog,
  type ProjectInstructionsTarget,
} from "./ProjectInstructionsDialog";

const projectKey = (project: EnvironmentProject) =>
  scopedProjectKey(scopeProjectRef(project.environmentId, project.id));

function errorDescription(error: unknown) {
  return error instanceof Error ? { description: error.message } : {};
}

export function ProjectsPage() {
  const search = useSearch({ from: "/_chat/projects" });
  const navigate = useNavigate();
  const projects = useProjects()
    .filter((project) => project.isScratch !== true && !project.archivedAt)
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const shells = useVisibleThreadShells();
  const { environments } = useEnvironments();
  const spansEnvironments = new Set(projects.map((project) => project.environmentId)).size > 1;
  const selected =
    projects.find((project) => projectKey(project) === search.project) ?? projects[0] ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <h1 className="truncate text-sm font-medium">Projects</h1>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Projects"
          className="max-h-48 shrink-0 overflow-y-auto border-b border-border py-2 md:max-h-none md:w-64 md:border-r md:border-b-0"
        >
          {projects.length === 0 ? (
            <p className="px-4 text-sm text-muted-foreground">Add a project to get started.</p>
          ) : (
            <ul>
              {projects.map((project) => {
                const key = projectKey(project);
                const hasCoordinator =
                  findProjectCoordinator(shells, project.environmentId, project.id) !== null;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      aria-current={selected !== null && key === projectKey(selected)}
                      className={cn(
                        "flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                        selected !== null && key === projectKey(selected) && "bg-accent",
                      )}
                      onClick={() =>
                        void navigate({ to: "/projects", search: { project: key }, replace: true })
                      }
                    >
                      <ProjectFavicon project={project} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{project.title}</span>
                      {spansEnvironments ? (
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {environments.find(
                            (environment) => environment.environmentId === project.environmentId,
                          )?.label ?? ""}
                        </span>
                      ) : null}
                      {hasCoordinator ? (
                        <span
                          aria-label="Has a coordinator"
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <ProjectDetail key={projectKey(selected)} project={selected} shells={shells} />
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}

function ProjectDetail(props: {
  readonly project: EnvironmentProject;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const { project, shells } = props;
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders().get(project.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const settings: ServerSettings | null =
    environments.find((environment) => environment.environmentId === project.environmentId)
      ?.serverConfig?.settings ?? null;
  const canOperate = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const canWriteFiles = useEnvironmentScope(project.environmentId, AuthFilesystemWriteScope);
  const coordinator = findProjectCoordinator(shells, project.environmentId, project.id);
  const threads = projectAgentThreads(shells, project.environmentId, project.id);
  const nowMinute = useNowMinute();
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState<ProjectInstructionsTarget | null>(null);

  const coordinatorModel: ModelSelection | null =
    coordinator?.modelSelection ??
    (settings
      ? resolveCoordinatorModelSelection({
          settings,
          providers,
          projectId: project.id,
          now: Date.parse(`${nowMinute}Z`),
        })
      : null);
  const agentModel: ModelSelection | null = settings
    ? (resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(providers, settings, project.id))
    : null;

  const openCoordinator = async (threadToShow?: EnvironmentThreadShell) => {
    if (settings === null || busy) return;
    setBusy(true);
    try {
      const ref = await ensureProjectCoordinator({
        project,
        existing: coordinator,
        settings,
        providers,
      });
      if (threadToShow) useRightPanelStore.getState().openProjectThreads(ref, threadToShow.id);
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open the coordinator",
        ...errorDescription(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const releaseCoordinator = async () => {
    if (coordinator === null || busy) return;
    setBusy(true);
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.setTag,
      {
        environmentId: project.environmentId,
        input: { threadId: coordinator.id, tag: COORDINATOR_THREAD_TAG, tagged: false },
      },
      { label: "Release coordinator", reportFailure: false },
    );
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not release the coordinator",
        ...errorDescription(squashAtomCommandFailure(result)),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Coordinator released",
      description: `“${coordinator.title}” is now an ordinary thread. Start a new coordinator any time.`,
    });
  };

  const editInstructions = async () => {
    if (busy) return;
    setBusy(true);
    const result = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.readFile({
        environmentId: project.environmentId,
        input: {
          cwd: project.workspaceRoot,
          relativePath: PROJECT_INSTRUCTIONS_PATH,
          allowMissing: true,
        },
      }),
      { label: "Read project instructions", reportFailure: false, refresh: true },
    );
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not read instructions",
        ...errorDescription(squashAtomCommandFailure(result)),
      });
      return;
    }
    if (result.value.truncated) {
      toastManager.add({
        type: "error",
        title: `${PROJECT_INSTRUCTIONS_PATH} is too large to edit here`,
        description: "Open it from the Files panel instead.",
      });
      return;
    }
    setInstructions({
      environmentId: project.environmentId,
      cwd: project.workspaceRoot,
      projectTitle: project.title,
      contents: result.value.contents,
      exists: result.value.exists !== false,
    });
  };

  const openModelSettings = () =>
    void navigate({
      to: "/settings/threads",
      search: { project: deriveLogicalProjectKeyFromSettings(project, groupingSettings) },
    });

  return (
    <WorkspacePageContainer>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{project.title}</h2>
        <p className="truncate text-xs text-muted-foreground">{project.workspaceRoot}</p>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-sm font-medium">Coordinator</h3>
            <p className="text-sm text-muted-foreground">
              {coordinator
                ? "A persistent thread that plans the work and delegates it to agent threads. Their threads open beside it."
                : "Start a persistent thread that plans the work and delegates it to agent threads."}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {coordinator ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!canOperate || busy}
                onClick={() => void releaseCoordinator()}
              >
                Release
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={!canOperate || settings === null || busy}
              onClick={() => void openCoordinator()}
            >
              {coordinator ? "Open coordinator" : "Start coordinator"}
            </Button>
          </div>
        </div>
        {coordinator ? (
          <p className="text-xs text-muted-foreground">
            {projectThreadActivity(coordinator) ?? "Idle"} · {coordinator.title} · updated{" "}
            <RelativeTime timestamp={coordinator.updatedAt} />
          </p>
        ) : null}
        {canOperate ? null : (
          <p className="text-xs text-muted-foreground">This connection cannot start threads.</p>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-sm font-medium">Models</h3>
            <p className="text-sm text-muted-foreground">
              Set for this project, or for every project, in Settings → Threads.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={openModelSettings}>
            Change models
          </Button>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Coordinator</dt>
          <dd className="truncate">{coordinatorModel?.model ?? "No provider available"}</dd>
          <dt className="text-muted-foreground">Agent threads</dt>
          <dd className="truncate">{agentModel?.model ?? "No provider available"}</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-sm font-medium">Instructions</h3>
            <p className="text-sm text-muted-foreground">
              {PROJECT_INSTRUCTIONS_PATH} in the project root. The coordinator and every agent read
              it.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!canWriteFiles || busy}
            onClick={() => void editInstructions()}
          >
            Edit instructions
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Threads</h3>
        {threads.length === 0 ? (
          <p className="text-sm text-muted-foreground">No threads in this project yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {threads.map((thread) => {
              const activity = projectThreadActivity(thread);
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() =>
                      coordinator
                        ? void openCoordinator(thread)
                        : void navigate({
                            to: "/$environmentId/$threadId",
                            params: buildThreadRouteParams(
                              scopeThreadRef(project.environmentId, thread.id),
                            ),
                          })
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                    {activity ? <span className="shrink-0 text-xs">{activity}</span> : null}
                    <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
                      {thread.modelSelection.model}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <RelativeTime timestamp={thread.updatedAt} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {instructions ? (
        <ProjectInstructionsDialog target={instructions} onClose={() => setInstructions(null)} />
      ) : null}
    </WorkspacePageContainer>
  );
}
