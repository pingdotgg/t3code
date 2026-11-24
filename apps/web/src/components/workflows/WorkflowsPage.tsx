import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  workflowReferenceIssue,
  workflowReferencePullRequest,
} from "@t3tools/client-runtime/workflows";
import { EnvironmentId, ThreadId, type WorkflowRunReference } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { FileCode2Icon, WorkflowIcon } from "lucide-react";
import { lazy, Suspense, useState, type MouseEvent } from "react";

import { contextMenuSourceOf } from "../../contextMenuSource";
import { type FileContextMenuAction, useFileContextMenu } from "../../fileContextMenu";
import { openThreadToTheSide } from "../../layout/layoutDrag";
import { selectFocusedPane } from "../../layout/layoutModel";
import { useLayoutStore } from "../../layout/layoutStore";
import { useLayoutPageLocation } from "../../layout/pageNavigation";
import { requestLayoutSurfacePlacement } from "../../layout/surfaceSync";
import { cn } from "../../lib/utils";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { readLocalApi } from "../../localApi";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { threadlessSurfacesRef } from "../../threadlessSurfaces";
import { useWorkflowEnvironmentIds } from "./useWorkflowEnvironmentIds";
import { Button, InlineButton } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { PANE_BODY_UNDER_HEADER_CLASS, PaneNotch } from "../PaneNotch";
import { SettingsPaneHeader, SettingsTabNotch } from "../settings/SettingsTabNotch";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkflowRunsView, WorkflowsEmpty } from "./WorkflowRunsView";
import WorkflowPane from "./WorkflowPane";
import {
  activeWorkflowPaneTab,
  toggleWorkflowPaneTab,
  type WorkflowPaneState,
} from "./workflowPane.logic";
import { workflowsSearchFromUrl, type WorkflowsSearch } from "./workflowsSearch.logic";

const COPY_PATH = "copy-path";

// The editor brings the code view's highlighter with it, which the run list has no use for.
const WorkflowDefinitionEditor = lazy(() => import("./WorkflowDefinitionEditor"));

export function WorkflowsPage() {
  const location = useLayoutPageLocation();
  const search = workflowsSearchFromUrl(location.search);
  const navigate = useNavigate();
  const gt = useGT();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const workflowIds = useWorkflowEnvironmentIds();
  // Only servers with workflows on in Labs can be picked; a connected one with them off says so.
  const connected = environments.filter((environment) =>
    workflowIds.includes(environment.environmentId),
  );
  const asked = search.env === undefined ? null : EnvironmentId.make(search.env);
  const turnedOff =
    asked === null
      ? workflowIds.length === 0 && connectedIds.length > 0
      : connectedIds.includes(asked) && !workflowIds.includes(asked);
  // An environment the address names is kept while it is away: its run and file mean nothing on
  // another server.
  const environmentId =
    asked !== null
      ? (connected.find((environment) => environment.environmentId === asked)?.environmentId ??
        null)
      : (connected.find((environment) => environment.environmentId === primaryEnvironmentId)
          ?.environmentId ??
        connected[0]?.environmentId ??
        null);
  const select = (next: WorkflowsSearch) =>
    void navigate({ to: "/workflows", search: next, replace: true });
  // A level of the page, which the browser's Back should step out of again.
  const go = (next: WorkflowsSearch) => void navigate({ to: "/workflows", search: next });
  // Opening a run or file pins the environment it is on, so the same address never means another.
  const pinned = environmentId ?? search.env;
  const env = pinned === undefined ? {} : { env: pinned };
  const away =
    asked !== null && environmentId === null && !turnedOff
      ? (environments.find((environment) => environment.environmentId === asked)?.label ?? asked)
      : null;
  const run = search.run === undefined ? {} : { run: search.run };
  const editing = search.definitions === true || search.file !== undefined;
  // An open file stays open while its environment is away, so a draft in it is not lost.
  const fileEnvironmentId =
    environmentId ?? (search.file === undefined || turnedOff ? null : asked);
  const [fileActions, setFileActions] = useState<HTMLElement | null>(null);
  const definitions = useEnvironmentQuery(
    fileEnvironmentId === null || search.file === undefined
      ? null
      : serverEnvironment.workflowDefinition({ environmentId: fileEnvironmentId, input: {} }),
  );
  const fileMenu = useFileContextMenu(fileEnvironmentId);
  /** What a right click on the open file's name offers: its path, and the editors on that machine. */
  const showFileMenu = (event: MouseEvent) => {
    const api = readLocalApi();
    const directory = definitions.data?.directory;
    if (api === undefined || directory === undefined || search.file === undefined) return;
    event.preventDefault();
    const path = `${directory}/${search.file}`;
    const target = { environmentId: fileEnvironmentId, filePath: path, workspaceRoot: undefined };
    void api.contextMenu
      .show(
        [{ id: COPY_PATH, label: gt("Copy path") }, ...fileMenu.buildItems(target)],
        {
          x: event.clientX,
          y: event.clientY,
        },
        contextMenuSourceOf(event),
      )
      .then((picked) => {
        if (picked === null) return;
        if (picked === COPY_PATH) return void navigator.clipboard.writeText(path);
        return fileMenu.activate(picked as FileContextMenuAction, target);
      });
  };
  // The run stays in the address, so the breadcrumb back to the runs reopens it.
  const openDefinitions = (file: string | null) =>
    go({ ...env, ...run, definitions: true, ...(file === null ? {} : { file }) });
  // What is open beside the run, which belongs to the run: picking another one closes it.
  const pane: WorkflowPaneState =
    environmentId === null || editing || search.pane === undefined
      ? {}
      : search.tab === undefined
        ? { pane: search.pane }
        : { pane: search.pane, tab: search.tab };
  const paneOpen = pane.pane !== undefined;
  const shownTab = activeWorkflowPaneTab(pane);
  // Opening something pins the run it is from, so the address keeps naming the run it belongs to.
  const togglePane = (runId: string, tab: Parameters<typeof toggleWorkflowPaneTab>[1]) =>
    select({ ...env, run: runId, ...toggleWorkflowPaneTab(pane, tab) });

  const openReferenceBeside = (runId: string, reference: WorkflowRunReference) => {
    if (environmentId === null) return;
    const focusedPane = selectFocusedPane(useLayoutStore.getState().layout);
    const issue = workflowReferenceIssue(reference);
    if (issue !== null) {
      const surfaceOwner = threadlessSurfacesRef(environmentId, issue.projectId);
      if (focusedPane !== null) {
        requestLayoutSurfacePlacement(surfaceOwner, {
          kind: "split",
          paneId: focusedPane.id,
          side: "right",
        });
      }
      useRightPanelStore.getState().openIssue(surfaceOwner, {
        environmentId,
        projectId: issue.projectId,
        tracker: issue.tracker,
        ...(issue.host === undefined ? {} : { host: issue.host }),
        scope: issue.scope,
        key: issue.key,
        ...(reference.url === null ? {} : { url: reference.url }),
      });
      return;
    }
    const pullRequest = workflowReferencePullRequest(reference);
    if (pullRequest !== null) {
      const surfaceOwner = threadlessSurfacesRef(environmentId, pullRequest.projectId);
      if (focusedPane !== null) {
        requestLayoutSurfacePlacement(surfaceOwner, {
          kind: "split",
          paneId: focusedPane.id,
          side: "right",
        });
      }
      useRightPanelStore.getState().openPullRequest(surfaceOwner, {
        environmentId,
        projectId: pullRequest.projectId,
        ...(pullRequest.host === undefined ? {} : { host: pullRequest.host }),
        repository: pullRequest.repository,
        number: pullRequest.number,
        ...(reference.url === null ? {} : { url: reference.url }),
      });
      return;
    }
    togglePane(runId, { kind: reference.kind, key: reference.key });
  };

  const showEnvPicker =
    (connected.length > 1 && environmentId !== null) ||
    ((away !== null || turnedOff) && connected.length > 0);
  const showDefinitionsButton = environmentId !== null && !editing;

  return (
    <SidebarInset
      variant="pane"
      className="h-full min-h-0 overflow-hidden overscroll-y-none"
      {...workspaceAreaProps("workflows", 20)}
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Below md there is room for one thing, and an open pane is that thing. */}
        <div
          className={cn(
            "pane-mobile-chrome min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden",
            paneOpen ? "hidden md:flex" : "flex",
          )}
        >
          <SettingsPaneHeader transparent trailingEdge={!paneOpen}>
            <SettingsTabNotch
              title={gt("Workflows")}
              icon={<WorkflowIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />}
            >
              {editing ? (
                <span className="truncate">
                  <T>Workflows</T>
                </span>
              ) : (
                <h1 className="truncate">
                  <T>Workflows</T>
                </h1>
              )}
            </SettingsTabNotch>
            {showEnvPicker || showDefinitionsButton ? (
              <PaneNotch side="right" className="ms-auto shrink-0">
                <div className="flex items-center gap-1.5 [-webkit-app-region:no-drag]">
                  {showEnvPicker ? (
                    <Select
                      value={environmentId ?? asked}
                      onValueChange={(value) => {
                        if (value !== null) select({ env: value });
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={gt("Environment", { $context: "a T3 Code server to pick" })}
                      >
                        <SelectValue>
                          {away ??
                            (turnedOff
                              ? environments.find(
                                  (environment) => environment.environmentId === asked,
                                )?.label
                              : undefined) ??
                            connected.find(
                              (environment) => environment.environmentId === environmentId,
                            )?.label ??
                            environmentId}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {connected.map((environment) => (
                          <SelectItem
                            key={environment.environmentId}
                            value={environment.environmentId}
                          >
                            {environment.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : null}
                  {showDefinitionsButton ? (
                    <Button size="sm" variant="secondary" onClick={() => openDefinitions(null)}>
                      <FileCode2Icon />
                      <T context="workflow definition files">Definitions</T>
                    </Button>
                  ) : null}
                </div>
              </PaneNotch>
            ) : null}
          </SettingsPaneHeader>
          <div
            data-surface-reaches-under-header=""
            className={cn(
              "flex min-h-0 flex-1 flex-col pt-under-header",
              PANE_BODY_UNDER_HEADER_CLASS,
            )}
          >
            {editing ? (
              <div className="flex shrink-0 items-center gap-3 border-b border-divider px-4 py-2">
                <WorkspaceBreadcrumb ariaLabel={gt("Workflows breadcrumb")} className="flex-1">
                  <WorkspaceBreadcrumbItem>
                    <InlineButton
                      tone="muted"
                      onClick={() => go({ ...env, ...run })}
                      className="min-w-0 max-w-full"
                    >
                      <WorkspaceBreadcrumbText>
                        <T>Workflows</T>
                      </WorkspaceBreadcrumbText>
                    </InlineButton>
                  </WorkspaceBreadcrumbItem>
                  <WorkspaceBreadcrumbSeparator>
                    <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
                  </WorkspaceBreadcrumbSeparator>
                  <WorkspaceBreadcrumbItem current={search.file === undefined}>
                    {search.file === undefined ? (
                      <h1 className="truncate">
                        <T context="workflow definition files">Definitions</T>
                      </h1>
                    ) : (
                      <InlineButton
                        tone="muted"
                        onClick={() => openDefinitions(null)}
                        className="min-w-0 max-w-full"
                      >
                        <WorkspaceBreadcrumbText>
                          <T context="workflow definition files">Definitions</T>
                        </WorkspaceBreadcrumbText>
                      </InlineButton>
                    )}
                  </WorkspaceBreadcrumbItem>
                  {search.file === undefined ? null : (
                    <>
                      <WorkspaceBreadcrumbSeparator>
                        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
                      </WorkspaceBreadcrumbSeparator>
                      <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
                        <h1 className="min-w-0" onContextMenu={showFileMenu}>
                          <WorkspaceBreadcrumbText className="font-mono">
                            {search.file}
                          </WorkspaceBreadcrumbText>
                        </h1>
                      </WorkspaceBreadcrumbItem>
                    </>
                  )}
                </WorkspaceBreadcrumb>
                {search.file === undefined ? null : (
                  <div ref={setFileActions} className="flex shrink-0 items-center gap-2" />
                )}
              </div>
            ) : null}
            {editing && fileEnvironmentId !== null ? (
              <Suspense
                fallback={
                  <p className="p-6 text-body text-muted-foreground" role="status">
                    <T>Loading the editor…</T>
                  </p>
                }
              >
                <WorkflowDefinitionEditor
                  key={fileEnvironmentId}
                  environmentId={fileEnvironmentId}
                  file={search.file ?? null}
                  away={away}
                  onOpen={openDefinitions}
                  actions={fileActions}
                />
              </Suspense>
            ) : away !== null ? (
              <WorkflowsEmpty
                title={gt("{name} is not connected", { name: away })}
                description={gt(
                  "Its workflows show again when it reconnects. Pick another environment to see its runs.",
                )}
              />
            ) : turnedOff ? (
              <WorkflowsEmpty
                title={gt("Workflows are off")}
                description={
                  <T>
                    Turn them on for this server in{" "}
                    <Link to="/settings/labs" className="underline underline-offset-2">
                      Settings → Labs
                    </Link>
                    .
                  </T>
                }
              />
            ) : environmentId === null ? (
              <WorkflowsEmpty
                title={gt("No environment connected")}
                description={gt("Connect an environment to see its workflow runs.")}
              />
            ) : (
              <WorkflowRunsView
                key={environmentId}
                onOpenDefinitions={() => openDefinitions(null)}
                environmentId={environmentId}
                selectedRunId={search.run ?? null}
                paneOpen={paneOpen}
                shownTab={shownTab}
                onSelect={(runId) => select({ ...env, ...(runId === null ? {} : { run: runId }) })}
                onOpenThread={(_runId, thread) =>
                  openThreadToTheSide(
                    scopeThreadRef(
                      thread.environmentId === null
                        ? environmentId
                        : EnvironmentId.make(thread.environmentId),
                      ThreadId.make(thread.threadId),
                    ),
                  )
                }
                onOpenReference={openReferenceBeside}
              />
            )}
          </div>
        </div>
        {environmentId === null || !paneOpen ? null : (
          <aside
            aria-label={gt("Beside the run")}
            className="min-h-0 w-full shrink-0 md:w-1/2 md:max-w-2xl md:border-s md:border-divider"
          >
            <WorkflowPane
              environmentId={environmentId}
              runId={search.run ?? null}
              state={pane}
              onChange={(next) => select({ ...env, ...run, ...next })}
            />
          </aside>
        )}
      </div>
    </SidebarInset>
  );
}
