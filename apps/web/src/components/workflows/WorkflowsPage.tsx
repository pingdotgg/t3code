import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { isElectron } from "~/env";
import { cn } from "../../lib/utils";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkflowRunsView, WorkflowsEmpty } from "./WorkflowRunsView";
import WorkflowThreadPane from "./WorkflowThreadPane";

export interface WorkflowsSearch {
  readonly env?: string;
  readonly run?: string;
  /** The agent thread open beside the run, and the linked environment it is in when not `env`. */
  readonly thread?: string;
  readonly threadEnv?: string;
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
  const threadRef =
    environmentId === null || search.thread === undefined
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
          </WorkspacePageHeader>
          {environmentId === null ? (
            <WorkflowsEmpty
              title="No environment connected"
              description="Connect an environment to see its workflow runs."
            />
          ) : (
            <WorkflowRunsView
              key={environmentId}
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
