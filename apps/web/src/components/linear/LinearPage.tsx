import * as Schema from "effect/Schema";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { LinearError, type EnvironmentId, type LinearMutationInput } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { CircleDotIcon, RefreshCwIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { LinearSelect, LinearMessage } from "./LinearControls";
import { LinearIssues } from "./LinearIssues";
import { LinearIssuePanel } from "./LinearIssuePanel";
import { LinearProjects } from "./LinearProjects";
import { LinearInbox } from "./LinearInbox";
import { LinearDocuments } from "./LinearDocuments";
import { LinearCycles } from "./LinearCycles";
import { type LinearSearch, type LinearView } from "./linearSearch";

const isLinearError = Schema.is(LinearError);
const views: ReadonlyArray<{ id: LinearView; name: string }> = [
  { id: "inbox", name: "Inbox" },
  { id: "mine", name: "My issues" },
  { id: "created", name: "Created by me" },
  { id: "subscribed", name: "Subscribed" },
  { id: "all", name: "All issues" },
  { id: "active", name: "Active" },
  { id: "backlog", name: "Backlog" },
  { id: "triage", name: "Triage" },
  { id: "projects", name: "Projects" },
  { id: "cycles", name: "Cycles" },
  { id: "documents", name: "Documents" },
];
export function LinearPage() {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId = selected ?? primary;
  const config = environments.find((env) => env.environmentId === environmentId)?.serverConfig;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      {environmentId && config?.environment.capabilities.linear ? (
        <LinearWorkspace
          key={environmentId}
          environmentId={environmentId}
          environments={environments.map((env) => ({ id: env.environmentId, name: env.label }))}
          selectEnvironment={(id) =>
            setSelected(environments.find((env) => env.environmentId === id)?.environmentId ?? null)
          }
        />
      ) : (
        <LinearMessage>
          {environmentId && config
            ? "Update this environment’s T3 server to use the Linear integration."
            : "Connect an environment to open Linear."}
        </LinearMessage>
      )}
    </SidebarInset>
  );
}
function LinearWorkspace({
  environmentId,
  environments,
  selectEnvironment,
}: {
  environmentId: EnvironmentId;
  environments: ReadonlyArray<{ id: string; name: string }>;
  selectEnvironment: (id: string) => void;
}) {
  const search = useSearch({ from: "/_chat/linear" });
  const navigate = useNavigate();
  const change = (patch: Partial<LinearSearch>) => {
    void navigate({ to: "/linear", search: { ...search, ...patch } });
  };
  const connection = useEnvironmentQuery(
    linearEnvironment.connection({ environmentId, input: {} }),
  );
  const workspace = useEnvironmentQuery(
    connection.data?.connected ? linearEnvironment.workspace({ environmentId, input: {} }) : null,
  );
  const context = useEnvironmentQuery(
    search.team && connection.data?.connected
      ? linearEnvironment.teamContext({ environmentId, input: { id: search.team } })
      : null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creating, setCreating] = useState<{ parentId?: string; teamId?: string } | null>(null);
  const invalidate = useAtomSet(linearEnvironment.refreshes(environmentId));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = useAtomCommand(linearEnvironment.mutate, { reportFailure: false });
  const canWrite = useAtomValue(linearEnvironment.mutate.permissionAtom(environmentId));
  const refresh = () => {
    workspace.refresh();
    context.refresh();
    invalidate((value) => value + 1);
  };
  const mutate = async (input: LinearMutationInput) => {
    setPending(true);
    setError(null);
    const result = await run({ environmentId, input });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const failure = Cause.squash(result.cause);
      setError(failure instanceof Error ? failure.message : "Linear could not save the change.");
      return null;
    }
    return result.value;
  };
  const team = workspace.data?.teams.find((team) => team.id === search.team);
  const title = views.find((view) => view.id === search.view)?.name ?? "Linear";
  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-3">
        <CircleDotIcon className="size-5 text-primary" />
        <strong>Linear</strong>
        <span className="text-sm text-muted-foreground">{workspace.data?.organization.name}</span>
        <div className="ml-auto flex items-end gap-2">
          {environments.length > 1 && (
            <LinearSelect
              label="Environment"
              value={environmentId}
              options={environments}
              onChange={selectEnvironment}
            />
          )}
          <Button size="sm" variant="ghost" aria-label="Refresh Linear" onClick={refresh}>
            <RefreshCwIcon className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Linear connection settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <Settings2Icon className="size-4" />
          </Button>
          {canWrite && workspace.data && (
            <Button size="sm" onClick={() => setCreating({})}>
              <PlusIcon className="size-4" />
              New issue
            </Button>
          )}
        </div>
      </header>
      {(settingsOpen ||
        connection.data?.connected === false ||
        (isLinearError(workspace.failure) && workspace.failure.reason === "unauthorized")) && (
        <LinearConnectionSettings
          environmentId={environmentId}
          source={connection.data?.source ?? "disconnected"}
          onChanged={() => {
            connection.refresh();
            workspace.refresh();
            setSettingsOpen(false);
            invalidate((value) => value + 1);
          }}
        />
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b bg-destructive/10 px-5 py-3 text-sm text-destructive"
        >
          {error}
          <Button variant="ghost" size="sm" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {connection.error || workspace.error ? (
        <LinearMessage
          retry={() => {
            connection.refresh();
            workspace.refresh();
          }}
        >
          {connection.error ?? workspace.error}
        </LinearMessage>
      ) : null}
      {workspace.isPending && !workspace.data && (
        <LinearMessage>Loading your workspace…</LinearMessage>
      )}
      {workspace.data && (
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <nav
            aria-label="Linear views"
            className="flex w-48 shrink-0 flex-col gap-1 border-r p-3 max-md:w-full max-md:border-r-0 max-md:border-b"
          >
            <LinearSelect
              label="Team"
              value={search.team ?? ""}
              options={workspace.data.teams}
              onChange={(id) =>
                change({
                  team: id || undefined,
                  parent: undefined,
                  statusId: undefined,
                  cycle: undefined,
                  project: undefined,
                  label: undefined,
                  issue: undefined,
                })
              }
              empty="All teams"
            />
            <div className="mt-3 flex flex-col gap-1 max-md:flex-row max-md:overflow-x-auto">
              {views.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  aria-current={search.view === view.id ? "page" : undefined}
                  onClick={() =>
                    change({
                      view: view.id,
                      parent: undefined,
                      issue: undefined,
                      project: undefined,
                      cycle: undefined,
                    })
                  }
                  className={`whitespace-nowrap rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${search.view === view.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground"}`}
                >
                  {view.name}
                </button>
              ))}
            </div>
          </nav>
          <main
            className={`flex min-w-0 flex-1 flex-col ${search.issue || creating ? "max-md:hidden" : ""}`}
          >
            <div className="flex items-center gap-2 border-b px-5 py-4">
              <h1 className="font-semibold">{title}</h1>
              {team && <span className="text-xs text-muted-foreground">{team.key}</span>}
            </div>
            {context.error && (
              <LinearMessage retry={context.refresh}>{context.error}</LinearMessage>
            )}
            {search.view === "inbox" ? (
              <LinearInbox
                key={environmentId}
                environmentId={environmentId}
                onOpen={(id) => change({ issue: id })}
                onProject={(id) => change({ view: "projects", project: id })}
                onDocument={(id) => change({ view: "documents", document: id })}
                mutate={mutate}
                canWrite={canWrite && !pending}
              />
            ) : search.view === "documents" ? (
              <LinearDocuments
                key={search.team ?? "all"}
                environmentId={environmentId}
                search={search}
                change={change}
                mutate={mutate}
                canWrite={canWrite && !pending}
              />
            ) : search.view === "projects" ? (
              <LinearProjects
                key={search.team ?? "all"}
                environmentId={environmentId}
                search={search}
                workspace={workspace.data}
                change={change}
                mutate={mutate}
                canWrite={canWrite && !pending}
              />
            ) : search.view === "cycles" ? (
              <LinearCycles
                key={search.team ?? "all"}
                context={context.data}
                teamId={search.team}
                change={change}
                mutate={mutate}
                canWrite={canWrite && !pending}
              />
            ) : (
              <LinearIssues
                key={JSON.stringify({ ...search, issue: undefined })}
                environmentId={environmentId}
                search={search}
                context={context.data}
                users={workspace.data.users}
                change={change}
                mutate={mutate}
                canWrite={canWrite && !pending}
              />
            )}
          </main>
          {(search.issue || creating) && (
            <section
              aria-label={creating ? "Create issue" : "Issue details"}
              className="flex min-h-0 w-[min(48rem,55%)] flex-col border-l max-md:w-full max-md:flex-1 max-md:border-l-0"
            >
              <ScrollArea scrollbarGutter>
                <LinearIssuePanel
                  key={creating ? `new:${creating.parentId ?? ""}` : search.issue}
                  environmentId={environmentId}
                  issueId={creating ? undefined : search.issue}
                  teamId={creating?.teamId ?? search.team}
                  parentId={creating?.parentId}
                  workspace={workspace.data}
                  mutate={mutate}
                  canWrite={canWrite && !pending}
                  onClose={() => {
                    setCreating(null);
                    change({ issue: undefined });
                  }}
                  onOpen={(id) => {
                    setCreating(null);
                    change({ issue: id });
                  }}
                  onViewSubissues={(id, teamId) =>
                    change({
                      view: "all",
                      parent: id,
                      team: teamId,
                      issue: undefined,
                      project: undefined,
                      cycle: undefined,
                      statusId: undefined,
                      assignee: undefined,
                      label: undefined,
                      q: undefined,
                    })
                  }
                  onSubissue={(id, teamId) => setCreating({ parentId: id, teamId })}
                />
              </ScrollArea>
            </section>
          )}
        </div>
      )}
    </>
  );
}
function LinearConnectionSettings({
  environmentId,
  source,
  onChanged,
}: {
  environmentId: EnvironmentId;
  source: string;
  onChanged: () => void;
}) {
  const configure = useAtomCommand(linearEnvironment.configure, { reportFailure: false });
  const allowed = useAtomValue(linearEnvironment.configure.permissionAtom(environmentId));
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const save = async (input: Parameters<typeof configure>[0]["input"]) => {
    setPending(true);
    setMessage(null);
    const result = await configure({ environmentId, input });
    setPending(false);
    if (AsyncResult.isSuccess(result)) {
      setKey("");
      onChanged();
    } else setMessage(String(Cause.squash(result.cause)));
  };
  return (
    <form
      className="flex flex-wrap items-end gap-3 border-b bg-muted/30 px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ kind: "save", apiKey: key });
      }}
    >
      <div className="basis-full text-sm">
        <strong>Connect Linear</strong>
        <p className="text-muted-foreground">
          Use a personal API key with access to your teams. Credentials stay on this environment.
          This connection is shared with clients and agents authorized to read this environment.
          Current source: {source}.
        </p>
      </div>
      <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs">
        Personal API key
        <Input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={!allowed || pending}
        />
      </label>
      <Button size="sm" disabled={!allowed || pending || !key.trim()} type="submit">
        Connect
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!allowed || pending}
        onClick={() => void save({ kind: "environment" })}
      >
        Use environment key
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!allowed || pending}
        onClick={() => void save({ kind: "disconnect" })}
      >
        Disconnect
      </Button>
      {message && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {message}
        </p>
      )}
    </form>
  );
}
