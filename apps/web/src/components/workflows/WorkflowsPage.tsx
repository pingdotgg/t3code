import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { FileCode2Icon } from "lucide-react";
import { lazy, Suspense, useState, type MouseEvent } from "react";

import { isElectron } from "~/env";
import { type FileContextMenuAction, useFileContextMenu } from "../../fileContextMenu";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useWorkflowEnvironmentIds } from "./useWorkflowEnvironmentIds";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkflowRunsView, WorkflowsEmpty } from "./WorkflowRunsView";
import WorkflowThreadPane from "./WorkflowThreadPane";

const COPY_PATH = "copy-path";

// The editor brings the code view's highlighter with it, which the run list has no use for.
const WorkflowDefinitionEditor = lazy(() => import("./WorkflowDefinitionEditor"));

export interface WorkflowsSearch {
  readonly env?: string;
  readonly run?: string;
  /** The agent thread open beside the run, and the linked environment it is in when not `env`. */
  readonly thread?: string;
  readonly threadEnv?: string;
  /** Show the definition files instead of the runs: all of them, or `file` in the editor. */
  readonly definitions?: boolean;
  readonly file?: string;
}

export function WorkflowsPage() {
  const search = useSearch({ from: "/_chat/workflows" });
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
      .show([{ id: COPY_PATH, label: gt("Copy path") }, ...fileMenu.buildItems(target)], {
        x: event.clientX,
        y: event.clientY,
      })
      .then((picked) => {
        if (picked === null) return;
        if (picked === COPY_PATH) return void navigator.clipboard.writeText(path);
        return fileMenu.activate(picked as FileContextMenuAction, target);
      });
  };
  const openDefinitions = (file: string | null) =>
    go({ ...env, definitions: true, ...(file === null ? {} : { file }) });
  const threadRef =
    environmentId === null || search.thread === undefined || editing
      ? null
      : scopeThreadRef(
          search.threadEnv === undefined ? environmentId : EnvironmentId.make(search.threadEnv),
          ThreadId.make(search.thread),
        );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Below md there is room for one thing, and an open transcript is that thing. */}
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col bg-background",
            threadRef === null ? "flex" : "hidden md:flex",
          )}
        >
          <WorkspacePageHeader
            electron={isElectron}
            reserveNativeControls={threadRef === null}
            className="border-b"
          >
            <WorkspaceBreadcrumb ariaLabel={gt("Workflows breadcrumb")} className="flex-1">
              <WorkspaceBreadcrumbItem current={!editing}>
                {editing ? (
                  <button
                    type="button"
                    onClick={() => go({ ...env, ...run })}
                    className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <WorkspaceBreadcrumbText>
                      <T>Workflows</T>
                    </WorkspaceBreadcrumbText>
                  </button>
                ) : (
                  <h1 className="truncate">
                    <T>Workflows</T>
                  </h1>
                )}
              </WorkspaceBreadcrumbItem>
              {editing ? (
                <>
                  <WorkspaceBreadcrumbSeparator>
                    <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
                  </WorkspaceBreadcrumbSeparator>
                  <WorkspaceBreadcrumbItem current={search.file === undefined}>
                    {search.file === undefined ? (
                      <h1 className="truncate">
                        <T context="workflow definition files">Definitions</T>
                      </h1>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openDefinitions(null)}
                        className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <WorkspaceBreadcrumbText>
                          <T context="workflow definition files">Definitions</T>
                        </WorkspaceBreadcrumbText>
                      </button>
                    )}
                  </WorkspaceBreadcrumbItem>
                </>
              ) : null}
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
            {(connected.length > 1 && environmentId !== null) ||
            ((away !== null || turnedOff) && connected.length > 0) ? (
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
                        ? environments.find((environment) => environment.environmentId === asked)
                            ?.label
                        : undefined) ??
                      connected.find((environment) => environment.environmentId === environmentId)
                        ?.label ??
                      environmentId}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connected.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {search.file === undefined ? null : (
              <div ref={setFileActions} className="flex shrink-0 items-center gap-2" />
            )}
            {environmentId === null || editing ? null : (
              <Button size="sm" variant="outline" onClick={() => openDefinitions(null)}>
                <FileCode2Icon />
                <T context="workflow definition files">Definitions</T>
              </Button>
            )}
          </WorkspacePageHeader>
          {editing && fileEnvironmentId !== null ? (
            <Suspense
              fallback={
                <p className="p-6 text-sm text-muted-foreground" role="status">
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
              openThreadId={search.thread ?? null}
              onSelect={(runId) => select({ ...env, ...(runId === null ? {} : { run: runId }) })}
              onOpenThread={(thread) =>
                select(
                  // Asking for the open one again closes it, as the pressed button says it will.
                  thread.threadId === search.thread
                    ? { ...env, ...run }
                    : {
                        ...env,
                        ...run,
                        thread: thread.threadId,
                        ...(thread.environmentId === null
                          ? {}
                          : { threadEnv: thread.environmentId }),
                      },
                )
              }
            />
          )}
        </div>
        {threadRef === null ? null : (
          <aside
            aria-label={gt("Agent transcript")}
            className="min-h-0 w-full shrink-0 bg-background md:w-1/2 md:max-w-2xl md:border-s"
          >
            <WorkflowThreadPane
              key={`${threadRef.environmentId}:${threadRef.threadId}`}
              threadRef={threadRef}
              onClose={() => select({ ...env, ...run })}
            />
          </aside>
        )}
      </div>
    </SidebarInset>
  );
}
