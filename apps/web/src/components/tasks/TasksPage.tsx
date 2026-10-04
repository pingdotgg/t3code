import { appAtomRegistry } from "../../rpc/atomRegistry";
import { taskLinks } from "../../state/tasks";
import { randomUUID } from "../../lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  type ExternalTask,
  type TaskSource,
  type TaskResult,
  type TaskRequest,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import { useProjects, useServerConfigs } from "../../state/entities";
import { tasksExecute, tasksConfigure } from "../../state/tasks";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { taskBranchName, taskContextPrompt, taskWorkRoute } from "./taskContext";

const optionalOperationId = Schema.NullOr(Schema.String);

const defaults: TaskSource = { provider: "github", baseUrl: "https://github.com", scope: "" };

/** Select an environment-local project before browsing or configuring its native task source. */
export function TasksPage() {
  const projects = useProjects();
  const [selected, setSelected] = useLocalStorage("t3code.tasks.project", "", Schema.String);
  const project = projects.find((p) => JSON.stringify([p.environmentId, p.id]) === selected);
  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <h1>Tasks</h1>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
        <label>
          Project and environment
          <select
            className="ml-3 rounded border bg-background p-2"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose a project</option>
            {projects.map((p) => (
              <option
                key={JSON.stringify([p.environmentId, p.id])}
                value={JSON.stringify([p.environmentId, p.id])}
              >
                {p.title} · {p.environmentId}
              </option>
            ))}
          </select>
        </label>
        {project ? (
          <ProjectTasks
            key={selected}
            projectRef={scopeProjectRef(project.environmentId, project.id)}
          />
        ) : (
          <p>Select the project and environment where the agent should work.</p>
        )}
      </div>
    </SidebarInset>
  );
}

/** Browse provider tasks and launch work through existing project drafts, retaining links across retries. */
function ProjectTasks({ projectRef }: { projectRef: ScopedProjectRef }) {
  const config = useServerConfigs().get(projectRef.environmentId);
  const supported = config?.environment.capabilities.externalTasks === true;
  const execute = useAtomCommand(tasksExecute, { reportFailure: false });
  const configure = useAtomCommand(tasksConfigure, { reportFailure: false });
  const createThread = useNewThreadHandler();
  const navigate = useNavigate();
  const operating = useRef(false);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [source, setSource] = useState<TaskSource>(defaults);
  const [configOpen, setConfigOpen] = useState(false);
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("open");
  const [selected, setSelected] = useState<ExternalTask | null>(null);
  const [fieldOptions, setFieldOptions] = useState<TaskResult["fieldOptions"]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [view, setView] = useState<"list" | "projects" | "items">("list");
  const [creating, setCreating] = useState(false);
  const [projectItemId, setProjectItemId] = useState<string>();
  const [links, setLinks] = useState<TaskResult["links"]>([]);
  const generation = useRef(0);
  const owner = useRef(true);
  useEffect(() => {
    owner.current = true;
    return () => {
      owner.current = false;
      generation.current++;
    };
  }, []);

  const request = useCallback(
    async (input: Omit<TaskRequest, "projectId">) => {
      const response = await execute({
        environmentId: projectRef.environmentId,
        input: { ...input, projectId: projectRef.projectId },
      });
      if (response._tag === "Success") return response.value;
      const failure = squashAtomCommandFailure(response);
      throw failure instanceof Error ? failure : new Error("The task request failed.");
    },
    [execute, projectRef.environmentId, projectRef.projectId],
  );
  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    void request({ action: "status" })
      .then(async (value) => {
        if (disposed) return;
        setResult(value);
        if (value.source) {
          setSource(value.source);
          const page = await request({ action: "list", filter: "open" });
          if (!disposed) setResult(page);
        } else setConfigOpen(true);
      })
      .catch((cause) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Could not read task settings.");
      })
      .finally(() => {
        if (!disposed) setInitializing(false);
      });
    void request({ action: "links" })
      .then((value) => {
        if (!disposed) setLinks(value.links);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
    // The component is keyed by environment + project; commands are stable for that owner.
  }, [supported, request]);

  /** Run a provider request against the selected project and ignore results from a superseded view. */
  async function perform(action: () => Promise<void>) {
    if (operating.current) return;
    operating.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      if (owner.current)
        setError(cause instanceof Error ? cause.message : "The task request failed.");
    } finally {
      operating.current = false;
      if (owner.current) setBusy(false);
    }
  }
  /** Load one task page with explicit navigation state and provider-error recovery. */
  async function browse(
    action: "list" | "projects" | "items" = view,
    cursor?: string,
    id = projectItemId,
  ) {
    const current = ++generation.current;
    const value = await request({
      action,
      query,
      filter,
      ...(cursor ? { cursor } : {}),
      ...(id ? { id } : {}),
    });
    if (current !== generation.current || !owner.current) return;
    setView(action);
    setResult((previous) =>
      cursor && previous ? { ...value, tasks: [...previous.tasks, ...value.tasks] } : value,
    );
  }
  /** Reuse an existing linked thread or seed a launch draft without eagerly creating another worktree. */
  async function start(task: ExternalTask, worktree: boolean) {
    /** Add bounded task context to the existing draft once, preserving any prompt the user already wrote. */
    const seedDraft = (draftId: DraftId) => {
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(draftId)?.prompt ?? "";
      if (!existing.includes(`Source task: ${task.url}`))
        store.setPrompt(draftId, [existing, taskContextPrompt(task)].filter(Boolean).join("\n\n"));
    };
    const linked = (await request({ action: "links" })).links.find(
      (link) => link.taskUrl === task.url,
    );
    if (linked) {
      const draftId = useComposerDraftStore
        .getState()
        .getDraftIdByRef(scopeThreadRef(projectRef.environmentId, linked.threadId));
      if (draftId && !useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo)
        seedDraft(draftId);
      await navigate(taskWorkRoute(scopeThreadRef(projectRef.environmentId, linked.threadId)));
      return;
    }
    const worktreeBranch = worktree
      ? taskBranchName(task, {
          mode: config?.settings.branchNamingMode ?? "static",
          prefix: config?.settings.branchNamePrefix ?? "t3code",
          instructions: config?.settings.branchNameInstructions ?? "",
        })
      : null;
    const taskSource = result?.source;
    if (!taskSource) throw new Error("Connect the task source before starting work.");
    await createThread(projectRef, {
      envMode: worktree ? "worktree" : "local",
      environmentSelection: "manual",
      worktreeBranch,
      prepareDraft: async (draft) => {
        const reserved = await request({
          action: "link",
          link: {
            projectId: projectRef.projectId,
            threadId: draft.threadId,
            provider: taskSource.provider,
            taskUrl: task.url,
            taskKey: task.key,
            title: task.title,
          },
        });
        const canonical = reserved.links[0];
        if (!canonical)
          throw new Error(
            "The task link was not confirmed. Retry starting work after reconnecting.",
          );
        if (canonical.threadId !== draft.threadId) {
          const target = scopeThreadRef(projectRef.environmentId, canonical.threadId);
          const draftId = useComposerDraftStore.getState().getDraftIdByRef(target);
          if (draftId && !useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo)
            seedDraft(draftId);
          if (owner.current) await navigate(taskWorkRoute(target));
          return false;
        }
        seedDraft(draft.draftId);
        appAtomRegistry.refresh(
          taskLinks({
            environmentId: projectRef.environmentId,
            input: { projectId: projectRef.projectId, action: "links", threadId: draft.threadId },
          }),
        );
        return owner.current;
      },
    });
  }
  if (!supported)
    return (
      <p>
        This environment does not support native tasks. Update its T3 server to connect a task
        source.
      </p>
    );
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setConfigOpen((v) => !v)}>
          Task source settings
        </Button>
        {result?.source ? <Button onClick={() => setCreating((v) => !v)}>New issue</Button> : null}
        {result?.source ? (
          <span className="text-sm">
            {result.source.provider} · {result.source.scope}
          </span>
        ) : null}
      </div>
      {configOpen ? (
        <form
          className="grid max-w-xl gap-3 rounded border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              const response = await configure({
                environmentId: projectRef.environmentId,
                input: {
                  projectId: projectRef.projectId,
                  source,
                  ...(token ? { token: Redacted.make(token) } : {}),
                },
              });
              setToken("");
              if (response._tag !== "Success") throw squashAtomCommandFailure(response);
              setConfigOpen(false);
              setSelected(null);
              await browse("list");
            });
          }}
        >
          <label>
            Source
            <select
              className="ml-2 rounded border bg-background p-2"
              value={source.provider}
              onChange={(e) => {
                const provider = e.target.value as TaskSource["provider"];
                setSource({
                  provider,
                  baseUrl:
                    provider === "github"
                      ? "https://github.com"
                      : provider === "linear"
                        ? "https://linear.app"
                        : "",
                  scope: "",
                });
                setToken("");
              }}
            >
              <option value="github">GitHub Issues and Projects</option>
              <option value="linear">Linear</option>
            </select>
          </label>
          <label>
            Site URL
            <Input
              value={source.baseUrl}
              onChange={(e) => setSource((s) => ({ ...s, baseUrl: e.target.value }))}
              required
            />
          </label>
          <label>
            {source.provider === "linear" ? "Team ID" : "Repository (owner/name)"}
            <Input
              value={source.scope}
              onChange={(e) => setSource((s) => ({ ...s, scope: e.target.value }))}
              required
            />
          </label>

          {source.provider === "linear" ? (
            <label>
              API token (leave blank to keep existing)
              <Input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          ) : (
            <p className="text-sm">
              Uses the selected environment's existing gh auth login account. GitHub Projects
              requires read:project access.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Task status changes are manual. Finishing an agent turn never closes an issue.
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Save connection
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const response = await configure({
                    environmentId: projectRef.environmentId,
                    input: { projectId: projectRef.projectId, source: null },
                  });
                  if (response._tag !== "Success") throw squashAtomCommandFailure(response);
                  setResult(null);
                  setSelected(null);
                  setToken("");
                })
              }
            >
              Disconnect
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {busy || initializing ? <p role="status">Loading tasks…</p> : null}
      {creating ? (
        <CreateTask
          key={projectRef.environmentId + projectRef.projectId}
          storageKey={projectRef.environmentId + projectRef.projectId}
          onCreate={async (changes, operationId) => {
            const value = await request({ action: "create", changes, operationId });
            setSelected(value.tasks[0] ?? null);
            setFieldOptions(value.fieldOptions);
            await browse("list");
          }}
        />
      ) : null}
      {result?.source ? (
        <>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                if (query.includes("://")) {
                  const value = await request({ action: "detail", id: query });
                  setSelected(value.tasks[0] ?? null);
                  setFieldOptions(value.fieldOptions);
                } else await browse("list");
              });
            }}
          >
            <div className="flex-1">
              <Input
                aria-label="Search tasks or paste an issue URL"
                placeholder="Search tasks or paste an issue URL"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              aria-label="Task status"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
            <Button type="submit" disabled={busy || initializing}>
              Search
            </Button>
            {result.source.provider === "github" ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void perform(() => browse("projects"))}
              >
                GitHub Projects
              </Button>
            ) : null}
          </form>
          <div className="grid grid-cols-2 items-start gap-4">
            <div className="flex flex-col gap-2" aria-label="Task results">
              {!busy && !initializing && result.tasks.length === 0 ? (
                <p>No matching tasks. Change the search or status filter and try again.</p>
              ) : null}
              {result.tasks.map((task) => (
                <button
                  type="button"
                  className="rounded border p-3 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring"
                  key={task.id}
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      if (view === "projects") {
                        setProjectItemId(task.id);
                        await browse("items", undefined, task.id);
                      } else if (view === "items") setSelected(task);
                      else {
                        const value = await request({ action: "detail", id: task.id });
                        setSelected(value.tasks[0] ?? null);
                        setFieldOptions(value.fieldOptions);
                      }
                    })
                  }
                >
                  <strong>
                    {task.key} · {task.title}
                  </strong>
                  <div>
                    {task.status} · {task.assignee}
                  </div>
                </button>
              ))}
              {result.nextCursor ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void perform(() => browse(view, result.nextCursor!))}
                >
                  Load more
                </Button>
              ) : null}
              {links.length ? (
                <details>
                  <summary>Linked development work ({links.length})</summary>
                  <p className="text-xs">
                    Removing a link keeps its thread and worktree. Use this if you deleted the
                    linked draft or want to start another thread.
                  </p>
                  {links.map((link) => (
                    <div key={link.threadId + link.taskUrl} className="p-2 text-sm">
                      <a href={link.taskUrl} target="_blank" rel="noreferrer">
                        {link.taskKey}
                      </a>{" "}
                      ·{" "}
                      <Link
                        {...taskWorkRoute(scopeThreadRef(projectRef.environmentId, link.threadId))}
                      >
                        {link.title}
                      </Link>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await request({
                              action: "unlink",
                              threadId: link.threadId,
                              id: link.taskUrl,
                            });
                            setLinks((await request({ action: "links" })).links);
                            appAtomRegistry.refresh(
                              taskLinks({
                                environmentId: projectRef.environmentId,
                                input: {
                                  projectId: projectRef.projectId,
                                  action: "links",
                                  threadId: link.threadId,
                                },
                              }),
                            );
                          })
                        }
                      >
                        Remove link
                      </Button>
                    </div>
                  ))}
                </details>
              ) : null}
            </div>
            {selected ? (
              <TaskDetail
                key={selected.url}
                task={selected}
                source={result.source}
                fieldOptions={fieldOptions}
                editable={view === "items" ? [] : result.editableFields}
                busy={busy}
                onStart={(worktree) => void perform(() => start(selected, worktree))}
                onWrite={(input) =>
                  request(input).then(async () => {
                    const value = await request({ action: "detail", id: selected.id });
                    setSelected(value.tasks[0] ?? selected);
                  })
                }
              />
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

/** Expose supported issue fields and comments while keeping external writes separate from agent execution. */
function TaskDetail({
  task,
  source,
  editable,
  busy,
  onStart,
  onWrite,
  fieldOptions,
}: {
  fieldOptions: TaskResult["fieldOptions"];
  task: ExternalTask;
  source: TaskSource;
  editable: TaskResult["editableFields"];
  busy: boolean;
  onStart: (worktree: boolean) => void;
  onWrite: (input: Omit<TaskRequest, "projectId">) => Promise<void>;
}) {
  const [comment, setComment] = useLocalStorage(
    `t3code.taskComment:${task.url}`,
    "",
    Schema.String,
  );
  const [field, setField] = useLocalStorage(
    `t3code.taskEditField:${task.url}`,
    "title",
    Schema.String,
  );
  const [value, setValue] = useLocalStorage(
    `t3code.taskEditValue:${task.url}`,
    task.title,
    Schema.String,
  );
  const [error, setError] = useState("");
  const [writing, setWriting] = useState(false);
  const [operationId, setOperationId] = useLocalStorage(
    `t3code.taskWrite:${task.url}`,
    null as string | null,
    optionalOperationId,
  );
  /** Keep one operation ID for a pending edit so retrying cannot silently duplicate an external write. */
  async function write(action: "comment" | "update") {
    if (writing || operationId) return;
    const id = operationId ?? randomUUID();
    setOperationId(id);
    setWriting(true);
    setError("");
    try {
      await onWrite({
        action,
        id: task.id,
        operationId: id,
        ...(action === "comment" ? { comment } : { changes: { [field]: value } }),
      });
      setOperationId(null);
      if (action === "comment") setComment("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The write failed.");
    } finally {
      setWriting(false);
    }
  }
  return (
    <article className="flex flex-col gap-3 rounded border p-4">
      <h2 className="text-lg font-medium">{task.title}</h2>
      <a className="underline" href={task.url} target="_blank" rel="noreferrer">
        Open {task.key} in {source.provider}
      </a>
      <p>
        {task.status} · Assignee: {task.assignee || "Unassigned"} · Priority:{" "}
        {task.priority || "Not available"}
      </p>
      <p>Labels: {task.labels.join(", ") || "None"}</p>
      <div className="whitespace-pre-wrap text-sm">{task.description}</div>
      {task.relationships.map((relation) => (
        <a key={relation.url} href={relation.url} target="_blank" rel="noreferrer">
          {relation.title}
        </a>
      ))}
      <p className="text-xs text-muted-foreground">
        Start work opens a draft. Choose the agent, model and base branch there, or select an
        existing worktree, then send when ready. Repeated starts reopen linked work.
      </p>
      <div className="flex gap-2">
        <Button disabled={busy || writing} onClick={() => onStart(false)}>
          Start thread
        </Button>
        <Button variant="outline" disabled={busy || writing} onClick={() => onStart(true)}>
          Start in worktree
        </Button>
      </div>
      {editable.length ? (
        <>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void write("update");
            }}
          >
            <label>
              Edit field
              <select
                className="ml-2"
                value={field}
                onChange={(e) => {
                  setField(e.target.value);
                  setValue("");
                }}
              >
                {editable.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              GitHub uses logins and label names, with open/closed status. Linear choices come from
              the selected team; its member and label lists show up to 100 entries. Comments show up
              to 100 entries.
            </p>
            {fieldOptions?.[field]?.length ? (
              <select
                aria-label="New field value"
                className="rounded border bg-background p-2"
                value={field === "labels" ? value.split(",").filter(Boolean) : value}
                multiple={field === "labels"}
                onChange={(e) =>
                  setValue(
                    field === "labels"
                      ? Array.from(e.target.selectedOptions)
                          .map((o) => o.value)
                          .join(",")
                      : e.target.value,
                  )
                }
              >
                <option value="">{field === "assignee" ? "Unassigned" : "Select value"}</option>
                {fieldOptions[field]!.filter((option) => !!option.value).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <Textarea
                aria-label="New field value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <Button disabled={writing || !!operationId} type="submit">
              Update source task
            </Button>
          </form>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void write("comment");
            }}
          >
            <Textarea
              aria-label="New source task comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button disabled={writing || !!operationId || !comment.trim()} type="submit">
              Publish comment to task
            </Button>
          </form>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Project items can start work here. Open the source item to edit its fields or comments.
        </p>
      )}
      {error || (operationId && !writing) ? (
        <div role="alert">
          <p>{error || "An earlier write has not been confirmed."}</p>
          <p>Check the source before another write.</p>
          <Button variant="outline" onClick={() => setOperationId(null)}>
            I checked the source; allow a new change
          </Button>
        </div>
      ) : null}
      {task.comments.map((c) => (
        <blockquote key={c.id} className="whitespace-pre-wrap border-l-2 pl-3 text-sm">
          <strong>{c.author}</strong>
          <p>{c.body}</p>
        </blockquote>
      ))}
    </article>
  );
}

/** Create an issue with a retained operation ID and preserve input after provider failures. */
function CreateTask({
  storageKey,
  onCreate,
}: {
  storageKey: string;
  onCreate: (changes: Record<string, string>, operationId: string) => Promise<void>;
}) {
  const [title, setTitle] = useLocalStorage(`t3code.taskTitle:${storageKey}`, "", Schema.String);
  const [description, setDescription] = useLocalStorage(
    `t3code.taskDescription:${storageKey}`,
    "",
    Schema.String,
  );
  const [operationId, setOperationId] = useLocalStorage(
    `t3code.taskCreate:${storageKey}`,
    null as string | null,
    optionalOperationId,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid max-w-xl gap-2 rounded border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || operationId) return;
        const id = randomUUID();
        setOperationId(id);
        setBusy(true);
        setError("");
        void onCreate({ title, description }, id)
          .then(() => {
            setTitle("");
            setDescription("");
            setOperationId(null);
          })
          .catch((cause) =>
            setError(cause instanceof Error ? cause.message : "Creation could not be confirmed."),
          )
          .finally(() => setBusy(false));
      }}
    >
      <label>
        Issue title
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Description
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <Button type="submit" disabled={busy || !!operationId || !title.trim()}>
        Create issue on source
      </Button>
      {error || (operationId && !busy) ? (
        <div role="alert">
          <p>
            {error || "Creation has not been confirmed."} Check the source for a created issue
            before trying again.
          </p>
          <Button type="button" variant="outline" onClick={() => setOperationId(null)}>
            I checked; allow another creation
          </Button>
        </div>
      ) : null}
    </form>
  );
}
