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
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
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
  /** Show the definition files instead of the runs. */
  readonly file?: boolean;
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
  const env = search.env === undefined ? {} : { env: search.env };
  const run = search.run === undefined ? {} : { run: search.run };
  const editing = search.file === true;
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
            <WorkspaceBreadcrumb ariaLabel="Workflows breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Workflows</h1>
              </WorkspaceBreadcrumbItem>
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
            {environmentId === null ? null : (
              <Button
                size="sm"
                variant={editing ? "secondary" : "outline"}
                aria-pressed={editing}
                onClick={() =>
                  select(editing ? { ...env, ...run } : { ...env, ...run, file: true })
                }
              >
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
              <WorkflowDefinitionEditor key={environmentId} environmentId={environmentId} />
            </Suspense>
          ) : (
            <WorkflowRunsView
              key={environmentId}
              onOpenDefinitions={() => select({ ...env, ...run, file: true })}
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
