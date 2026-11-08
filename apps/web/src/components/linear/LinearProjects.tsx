import type { EnvironmentId, LinearProjectDetail, LinearWorkspace } from "@t3tools/contracts";
import { useState } from "react";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ScrollArea } from "../ui/scroll-area";
import { LinearDocuments } from "./LinearDocuments";
import { LinearSelect, LinearMessage, LinearMarkdown, LinearPager } from "./LinearControls";
import type { LinearSearch } from "./linearSearch";
import type { LinearMutate } from "./linearTypes";

export function LinearProjects({
  environmentId,
  search,
  workspace,
  change,
  mutate,
  canWrite,
}: {
  environmentId: EnvironmentId;
  search: LinearSearch;
  workspace: typeof LinearWorkspace.Type;
  change: (patch: Partial<LinearSearch>) => void;
  mutate: LinearMutate;
  canWrite: boolean;
}) {
  const [cursors, setCursors] = useState<Array<string>>([]);
  const after = cursors.at(-1);
  const projects = useEnvironmentQuery(
    linearEnvironment.projects({
      environmentId,
      input: { ...(search.team ? { teamId: search.team } : {}), ...(after ? { after } : {}) },
    }),
  );
  const project = useEnvironmentQuery(
    search.project
      ? linearEnvironment.project({ environmentId, input: { id: search.project } })
      : null,
  );
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <ScrollArea scrollbarGutter>
        <div className="flex flex-col gap-4 p-5">
          {project.error || projects.error ? (
            <LinearMessage
              retry={() => {
                projects.refresh();
                project.refresh();
              }}
            >
              {project.error ?? projects.error}
            </LinearMessage>
          ) : null}
          {search.project && project.data ? (
            <>
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <h2 className="text-xl font-semibold">{project.data.name}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {project.data.status.name} · {project.data.lead?.name ?? "No lead"}
                    {project.data.targetDate ? ` · Due ${project.data.targetDate}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite}
                  onClick={() => setEditing(!editing)}
                >
                  Edit project
                </Button>
                <Button size="sm" variant="ghost" onClick={() => change({ project: undefined })}>
                  Back
                </Button>
              </div>
              {editing ? (
                <ProjectEditor
                  key={project.data.id}
                  project={project.data}
                  workspace={workspace}
                  teamId={search.team}
                  mutate={mutate}
                  canWrite={canWrite}
                  onDone={() => {
                    setEditing(false);
                    project.refresh();
                  }}
                />
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">{project.data.description}</p>
                  <LinearMarkdown text={project.data.content} />
                </>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => change({ view: "all", project: search.project, issue: undefined })}
              >
                Open project issues
              </Button>
              <ProjectMilestones
                key={project.data.id}
                project={project.data}
                mutate={mutate}
                canWrite={canWrite}
              />
              <LinearDocuments
                key={project.data.id}
                environmentId={environmentId}
                projectId={project.data.id}
                search={search}
                change={change}
                mutate={mutate}
                canWrite={canWrite}
              />
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Projects across {search.team ? "this team" : "your workspace"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite}
                  onClick={() => setCreating(!creating)}
                >
                  New project
                </Button>
              </div>
              {creating && (
                <ProjectEditor
                  workspace={workspace}
                  teamId={search.team}
                  mutate={mutate}
                  canWrite={canWrite}
                  onDone={(id) => {
                    setCreating(false);
                    projects.refresh();
                    if (id) change({ project: id });
                  }}
                />
              )}
              {projects.isPending && !projects.data && (
                <LinearMessage>Loading projects…</LinearMessage>
              )}
              {projects.data?.nodes.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  className="flex flex-col gap-2 rounded-lg border p-4 text-left hover:bg-accent"
                  onClick={() => change({ project: project.id })}
                >
                  <div className="flex justify-between gap-2">
                    <strong className="text-sm">{project.name}</strong>
                    <span className="text-xs text-muted-foreground">{project.status.name}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{project.description}</p>
                  <span className="text-xs text-muted-foreground">
                    {project.lead?.name ?? "No lead"}
                    {project.targetDate ? ` · ${project.targetDate}` : ""}
                  </span>
                </button>
              ))}
              {projects.data?.nodes.length === 0 && (
                <LinearMessage>No projects in this team yet.</LinearMessage>
              )}
            </>
          )}
        </div>
      </ScrollArea>
      {!search.project && (
        <LinearPager
          after={after}
          hasNextPage={projects.data?.pageInfo.hasNextPage ?? false}
          pending={projects.isPending}
          onPrevious={() => setCursors((values) => values.slice(0, -1))}
          onNext={() => {
            const cursor = projects.data?.pageInfo.endCursor;
            if (cursor) setCursors((values) => [...values, cursor]);
          }}
        />
      )}
    </>
  );
}
function ProjectEditor({
  project,
  workspace,
  teamId,
  mutate,
  canWrite,
  onDone,
}: {
  project?: typeof LinearProjectDetail.Type;
  workspace: typeof LinearWorkspace.Type;
  teamId: string | undefined;
  mutate: LinearMutate;
  canWrite: boolean;
  onDone: (id?: string) => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [content, setContent] = useState(project?.content ?? "");
  const [team, setTeam] = useState(teamId ?? workspace.teams[0]?.id ?? "");
  const [statusId, setStatusId] = useState(project?.status.id ?? "");
  const [leadId, setLeadId] = useState(project?.lead?.id ?? "");
  const [startDate, setStartDate] = useState(project?.startDate ?? "");
  const [targetDate, setTargetDate] = useState(project?.targetDate ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const result = await mutate(
      project
        ? {
            kind: "projectUpdate",
            id: project.id,
            input: {
              ...(name !== project.name ? { name } : {}),
              ...(description !== project.description ? { description } : {}),
              ...(content !== (project.content ?? "") ? { content } : {}),
              ...(statusId !== project.status.id ? { statusId } : {}),
              ...(leadId !== (project.lead?.id ?? "") ? { leadId: leadId || null } : {}),
              ...(startDate !== (project.startDate ?? "") ? { startDate: startDate || null } : {}),
              ...(targetDate !== (project.targetDate ?? "")
                ? { targetDate: targetDate || null }
                : {}),
            },
          }
        : { kind: "projectCreate", input: { name, description, content, teamIds: [team] } },
    );
    setBusy(false);
    if (result) onDone(result.id ?? undefined);
  };
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        Project name
        <Input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Summary
        <Input
          value={description}
          maxLength={255}
          onChange={(event) => setDescription(event.target.value)}
          disabled={busy}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Overview · Markdown
        <Textarea
          rows={6}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          disabled={busy}
        />
      </label>
      {project ? (
        <div className="grid grid-cols-2 gap-3">
          <LinearSelect
            label="Project status"
            value={statusId}
            onChange={setStatusId}
            options={workspace.projectStatuses}
          />
          <LinearSelect
            label="Project lead"
            value={leadId}
            onChange={setLeadId}
            options={workspace.users}
            empty="No lead"
          />
          <label className="flex flex-col gap-1 text-xs">
            Start date
            <Input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Target date
            <Input
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <LinearSelect
          label="Project team"
          value={team}
          onChange={setTeam}
          options={workspace.teams}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDone()}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={!canWrite || busy || !name.trim() || !team}>
          Save project
        </Button>
      </div>
    </form>
  );
}
function ProjectMilestones({
  project,
  mutate,
  canWrite,
}: {
  project: typeof LinearProjectDetail.Type;
  mutate: LinearMutate;
  canWrite: boolean;
}) {
  const [editor, setEditor] = useState<{
    id?: string;
    name: string;
    description: string;
    targetDate: string;
  } | null>(null);
  return (
    <section className="flex flex-col gap-3 border-t pt-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Milestones</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canWrite}
          onClick={() => setEditor({ name: "", description: "", targetDate: "" })}
        >
          New milestone
        </Button>
      </div>
      {project.projectMilestones.nodes.map((item) => (
        <div className="rounded border p-3" key={item.id}>
          <div className="flex items-center gap-2">
            <strong className="flex-1 text-sm">{item.name}</strong>
            <span className="text-xs text-muted-foreground">{item.targetDate}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canWrite}
              onClick={() =>
                setEditor({
                  id: item.id,
                  name: item.name,
                  description: item.description ?? "",
                  targetDate: item.targetDate ?? "",
                })
              }
            >
              Edit milestone
            </Button>
          </div>
          <LinearMarkdown text={item.description} />
        </div>
      ))}
      {editor && (
        <form
          className="flex flex-col gap-3 rounded border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const input = {
              name: editor.name,
              description: editor.description,
              targetDate: editor.targetDate || null,
            };
            void mutate(
              editor.id
                ? { kind: "projectMilestoneUpdate", id: editor.id, input }
                : { kind: "projectMilestoneCreate", input: { ...input, projectId: project.id } },
            ).then((result) => {
              if (result) setEditor(null);
            });
          }}
        >
          <Input
            aria-label="Milestone name"
            required
            value={editor.name}
            onChange={(event) => setEditor({ ...editor, name: event.target.value })}
          />
          <Textarea
            aria-label="Milestone description"
            value={editor.description}
            onChange={(event) => setEditor({ ...editor, description: event.target.value })}
          />
          <Input
            aria-label="Milestone target date"
            type="date"
            value={editor.targetDate}
            onChange={(event) => setEditor({ ...editor, targetDate: event.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={!canWrite || !editor.name.trim()}>
              Save milestone
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
