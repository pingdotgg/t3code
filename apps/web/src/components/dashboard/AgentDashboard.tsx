import { openAgentDashboardWindow } from "./dashboardPopup";
import { useEnvironments } from "../../state/environments";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useDeferredValue, useMemo, useState } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  dashboardEntries,
  dashboardThreadTarget,
  dashboardThreadMatches,
  type DashboardEntry,
  type AgentColumn,
} from "./agentDashboard";

const Preferences = Schema.Struct({
  search: Schema.String,
  project: Schema.String,
  workspace: Schema.String,
  environment: Schema.String,
  provider: Schema.String,
  status: Schema.String,
  pullRequest: Schema.String,
  showIdle: Schema.Boolean,
});
const DEFAULTS = {
  search: "",
  project: "",
  workspace: "",
  pullRequest: "",
  environment: "",
  provider: "",
  status: "",
  showIdle: false,
};
const COLUMNS: AgentColumn[] = ["Needs You", "Working", "Done", "Idle"];

/** Display and filter live thread shells across environments, reusing the existing client subscriptions. */
export function AgentDashboard({ detached = false }: { detached?: boolean }) {
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const connected = useMemo(
    () =>
      new Set(
        environments.filter((e) => e.connection.phase === "connected").map((e) => e.environmentId),
      ),
    [environments],
  );
  const [preferences, setPreferences] = useLocalStorage(
    "t3code.agentDashboard",
    DEFAULTS,
    Preferences,
  );
  const filters = useDeferredValue(preferences);
  const showIdle = preferences.showIdle || preferences.status === "Idle";
  const [limit, setLimit] = useState(60);
  const projectNames = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          JSON.stringify([project.environmentId, project.id]),
          project.title,
        ]),
      ),
    [projects],
  );
  const groups = useMemo(() => {
    const result = new Map(COLUMNS.map((column) => [column, [] as DashboardEntry[]]));
    const matching = threads.filter(
      (thread) =>
        !thread.archivedAt &&
        dashboardThreadMatches(
          thread,
          filters,
          projectNames.get(JSON.stringify([thread.environmentId, thread.projectId])) ?? "",
        ),
    );
    for (const entry of dashboardEntries(matching, connected))
      if (!filters.status || filters.status === entry.state.column)
        result.get(entry.state.column)!.push(entry);
    for (const group of result.values())
      group.sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));
    return result;
  }, [threads, filters, projectNames, connected]);
  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron && !detached}>
        <h1>Agent Dashboard</h1>
        {isElectron && !detached ? (
          <Button variant="outline" size="sm" onClick={openAgentDashboardWindow}>
            Pop out
          </Button>
        ) : null}
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label>
            Search
            <Input
              value={preferences.search}
              onChange={(e) => setPreferences((p) => ({ ...p, search: e.target.value }))}
            />
          </label>
          <label>
            Project
            <select
              className="block h-8 rounded border bg-background px-2 text-sm"
              value={preferences.project}
              onChange={(e) => setPreferences((p) => ({ ...p, project: e.target.value }))}
            >
              <option value="">All projects and environments</option>
              {projects.map((project) => {
                const key = JSON.stringify([project.environmentId, project.id]);
                return (
                  <option key={key} value={key}>
                    {project.title} · {project.environmentId}
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            Environment
            <select
              className="block h-8 rounded border bg-background"
              value={preferences.environment}
              onChange={(e) => setPreferences((p) => ({ ...p, environment: e.target.value }))}
            >
              <option value="">All environments</option>
              {environments.map((e) => (
                <option key={e.environmentId} value={e.environmentId}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select
              className="block h-8 rounded border bg-background"
              value={preferences.provider}
              onChange={(e) => setPreferences((p) => ({ ...p, provider: e.target.value }))}
            >
              <option value="">All providers</option>
              {[...new Set(threads.map((t) => t.providerInstanceId))].map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select
              className="block h-8 rounded border bg-background"
              value={preferences.status}
              onChange={(e) => setPreferences((p) => ({ ...p, status: e.target.value }))}
            >
              <option value="">All states</option>
              {COLUMNS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Workspace or branch
            <Input
              value={preferences.workspace}
              onChange={(e) => setPreferences((p) => ({ ...p, workspace: e.target.value }))}
            />
          </label>
          <label>
            Pull request
            <Input
              value={preferences.pullRequest}
              onChange={(e) => setPreferences((p) => ({ ...p, pullRequest: e.target.value }))}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={preferences.showIdle}
              onChange={(e) => setPreferences((p) => ({ ...p, showIdle: e.target.checked }))}
            />
            Show Idle
          </label>
        </div>
        <div
          className="grid grid-cols-3 items-start gap-4"
          style={{
            gridTemplateColumns: `repeat(${showIdle ? 4 : 3}, minmax(220px, 1fr))`,
          }}
        >
          {COLUMNS.filter((column) => column !== "Idle" || showIdle).map((column) => {
            const group = groups.get(column)!;
            return (
              <section key={column} aria-label={column} className="flex flex-col gap-2">
                <h2 className="font-medium">
                  {column} <span className="text-muted-foreground">({group.length})</span>
                </h2>
                {group.slice(0, limit).map((entry) => (
                  <DashboardCard
                    key={JSON.stringify([entry.thread.environmentId, entry.thread.id])}
                    entry={entry}
                    projectNames={projectNames}
                    detached={detached}
                  />
                ))}
                {group.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No matching agents</p>
                ) : null}
                {group.length > limit ? (
                  <Button variant="outline" onClick={() => setLimit((value) => value + 60)}>
                    Show more
                  </Button>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </SidebarInset>
  );
}

/** Open an existing thread and expose delegated work without creating duplicate agent sessions. */
function DashboardCard({
  entry,
  projectNames,
  detached,
}: {
  entry: DashboardEntry;
  projectNames: ReadonlyMap<string, string>;
  detached: boolean;
}) {
  const { thread, children, state } = entry;
  return (
    <article className="rounded-lg border bg-card p-3 text-sm">
      <Link
        {...dashboardThreadTarget(thread)}
        onClick={() => {
          if (detached) window.focus();
        }}
        className="block rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="font-medium">{thread.title || "Untitled thread"}</div>
        <div className="text-muted-foreground">
          {projectNames.get(JSON.stringify([thread.environmentId, thread.projectId]))} ·{" "}
          {thread.environmentId}
        </div>
        <div className="truncate text-muted-foreground">
          {thread.worktreePath ?? thread.branch ?? "Project workspace"}
        </div>
        <div>
          {thread.runtime?.providerName ?? thread.providerInstanceId} ·{" "}
          {thread.modelSelection.model}
        </div>
        <time className="text-xs text-muted-foreground" dateTime={thread.updatedAt}>
          {new Date(thread.updatedAt).toLocaleString()}
        </time>
        {thread.recentMessage ? (
          <p className="line-clamp-2 text-muted-foreground">{thread.recentMessage}</p>
        ) : null}
        <div>{state.label}</div>
        {thread.lineage.relationshipToParent === "subagent" ? (
          <div className="text-xs text-muted-foreground">Delegated agent</div>
        ) : null}
      </Link>
      {children.length ? (
        <details
          open={children.some((child) => child.state.column === "Needs You")}
          className="mt-2"
        >
          <summary>Delegated agents ({children.length})</summary>
          <div className="mt-2 grid gap-2">
            {children.map((child) => (
              <DashboardCard
                key={child.thread.id}
                entry={child}
                projectNames={projectNames}
                detached={detached}
              />
            ))}
          </div>
        </details>
      ) : null}
      {thread.pendingBackgroundTasks.length ? (
        <details className="mt-2">
          <summary>Background activity</summary>
          {thread.pendingBackgroundTasks.map((task) => (
            <p key={task.taskId}>
              {task.kind} · {task.description ?? task.taskId}
            </p>
          ))}
        </details>
      ) : null}
    </article>
  );
}
