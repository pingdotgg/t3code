import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { FileCode2Icon } from "lucide-react";
import { lazy, Suspense } from "react";

import { isElectron } from "~/env";
import { cn } from "../../lib/utils";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const connected = environments.filter((environment) =>
    connectedIds.includes(environment.environmentId),
  );
  const asked = search.env === undefined ? null : EnvironmentId.make(search.env);
  const environmentId =
    connected.find((environment) => environment.environmentId === asked)?.environmentId ??
    connected.find((environment) => environment.environmentId === primaryEnvironmentId)
      ?.environmentId ??
    connected[0]?.environmentId ??
    null;
  const select = (next: WorkflowsSearch) =>
    void navigate({ to: "/workflows", search: next, replace: true });
  // A level of the page, which the browser's Back should step out of again.
  const go = (next: WorkflowsSearch) => void navigate({ to: "/workflows", search: next });
  const env = search.env === undefined ? {} : { env: search.env };
  const run = search.run === undefined ? {} : { run: search.run };
  const editing = search.definitions === true || search.file !== undefined;
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
            <WorkspaceBreadcrumb ariaLabel="Workflows breadcrumb" className="flex-1">
              <WorkspaceBreadcrumbItem current={!editing}>
                {editing ? (
                  <button
                    type="button"
                    onClick={() => go({ ...env, ...run })}
                    className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <WorkspaceBreadcrumbText>Workflows</WorkspaceBreadcrumbText>
                  </button>
                ) : (
                  <h1 className="truncate">Workflows</h1>
                )}
              </WorkspaceBreadcrumbItem>
              {editing ? (
                <>
                  <WorkspaceBreadcrumbSeparator>
                    <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
                  </WorkspaceBreadcrumbSeparator>
                  <WorkspaceBreadcrumbItem current={search.file === undefined}>
                    {search.file === undefined ? (
                      <h1 className="truncate">Definitions</h1>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openDefinitions(null)}
                        className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <WorkspaceBreadcrumbText>Definitions</WorkspaceBreadcrumbText>
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
                    <h1 className="min-w-0">
                      <WorkspaceBreadcrumbText className="font-mono">
                        {search.file}
                      </WorkspaceBreadcrumbText>
                    </h1>
                  </WorkspaceBreadcrumbItem>
                </>
              )}
            </WorkspaceBreadcrumb>
            {connected.length > 1 && environmentId !== null ? (
              <Select
                value={environmentId}
                onValueChange={(value) => {
                  if (value !== null) select({ env: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Environment">
                  <SelectValue>
                    {connected.find((environment) => environment.environmentId === environmentId)
                      ?.label ?? environmentId}
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
            {environmentId === null || editing ? null : (
              <Button size="sm" variant="outline" onClick={() => openDefinitions(null)}>
                <FileCode2Icon />
                Definitions
              </Button>
            )}
          </WorkspacePageHeader>
          {environmentId === null ? (
            <WorkflowsEmpty
              title="No environment connected"
              description="Connect an environment to see its workflow runs."
            />
          ) : editing ? (
            <Suspense
              fallback={
                <p className="p-6 text-sm text-muted-foreground" role="status">
                  Loading the editor…
                </p>
              }
            >
              <WorkflowDefinitionEditor
                key={environmentId}
                environmentId={environmentId}
                file={search.file ?? null}
                onOpen={openDefinitions}
              />
            </Suspense>
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
            aria-label="Agent transcript"
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
