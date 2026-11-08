import { LinearUpload, linearFileMarkdown } from "./LinearUpload";
import type { EnvironmentId, LinearIssueDetail, LinearWorkspace } from "@t3tools/contracts";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { XIcon, CopyIcon, PlayIcon } from "lucide-react";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { LinearSelect, LinearMessage, LinearMarkdown, LinearPager } from "./LinearControls";
import type { LinearMutate } from "./linearTypes";

type Workspace = typeof LinearWorkspace.Type;
export function LinearIssuePanel({
  environmentId,
  issueId,
  teamId,
  parentId,
  workspace,
  mutate,
  canWrite,
  onClose,
  onOpen,
  onSubissue,
  onViewSubissues,
}: {
  environmentId: EnvironmentId;
  issueId: string | undefined;
  teamId: string | undefined;
  parentId: string | undefined;
  workspace: Workspace;
  mutate: LinearMutate;
  canWrite: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onSubissue: (id: string, teamId: string) => void;
  onViewSubissues: (id: string, teamId: string) => void;
}) {
  const detail = useEnvironmentQuery(
    issueId ? linearEnvironment.issue({ environmentId, input: { id: issueId } }) : null,
  );
  const refresh = detail.refresh;
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const issue = detail.data;
  const issueTeam = issue?.team.id ?? teamId;
  const context = useEnvironmentQuery(
    issueTeam ? linearEnvironment.teamContext({ environmentId, input: { id: issueTeam } }) : null,
  );
  const startWork = () => {
    if (!issue) return;
    const prompt = `Work on Linear issue ${issue.identifier}: ${issue.title}\n${issue.url}\n\n${issue.description ?? ""}\n\nRead the issue and its discussion before starting. Keep the issue updated as work progresses.`;
    void navigate({
      href: `/new?prompt=${encodeURIComponent(prompt.slice(0, 8000).replace(/[\uD800-\uDBFF]$/, ""))}`,
    });
  };
  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-muted-foreground">
          {issue?.identifier ?? "New issue"}
        </span>
        {issue && (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Copy issue link"
              onClick={() => {
                void navigator.clipboard.writeText(issue.url).then(() => setCopied(true));
              }}
            >
              <CopyIcon className="size-4" />
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button size="sm" variant="outline" onClick={startWork}>
              <PlayIcon className="size-4" />
              Start work
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" aria-label="Close issue" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      {detail.error && <LinearMessage retry={refresh}>{detail.error}</LinearMessage>}
      {issueId && !issue && detail.isPending && <LinearMessage>Loading issue…</LinearMessage>}
      {!issueId || editing ? (
        <IssueEditor
          key={issueId ?? "new"}
          environmentId={environmentId}
          issue={issue ?? undefined}
          teamId={issueTeam}
          parentId={parentId}
          workspace={workspace}
          mutate={mutate}
          canWrite={canWrite}
          onCancel={issueId ? () => setEditing(false) : onClose}
          onSaved={(id) => {
            setEditing(false);
            onOpen(id);
            refresh();
          }}
        />
      ) : issue ? (
        <>
          <div className="flex items-start gap-3">
            <h2 className="flex-1 text-xl font-semibold wrap-anywhere">{issue.title}</h2>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          </div>
          {issue.archivedAt && (
            <p className="rounded border p-3 text-sm text-muted-foreground">
              This issue is archived.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 text-sm text-muted-foreground">
            <span>
              Status <strong className="block text-foreground">{issue.state.name}</strong>
            </span>
            <span>
              Assignee{" "}
              <strong className="block text-foreground">
                {issue.assignee?.name ?? "Unassigned"}
              </strong>
            </span>
            <span>
              Priority <strong className="block text-foreground">{issue.priorityLabel}</strong>
            </span>
            <span>
              Project{" "}
              <strong className="block text-foreground">{issue.project?.name ?? "None"}</strong>
            </span>
            <span>
              Cycle{" "}
              <strong className="block text-foreground">
                {issue.cycle?.name ?? (issue.cycle ? `Cycle ${issue.cycle.number}` : "None")}
              </strong>
            </span>
            <span>
              Due date <strong className="block text-foreground">{issue.dueDate ?? "None"}</strong>
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {issue.labels.nodes.map((label) => (
              <span key={label.id} className="rounded-full border px-2 py-1 text-xs">
                {label.name}
              </span>
            ))}
          </div>
          <LinearMarkdown text={issue.description} />
          {issue.parent && (
            <button
              className="text-left text-sm text-primary hover:underline"
              type="button"
              onClick={() => onOpen(issue.parent!.id)}
            >
              Parent: {issue.parent.identifier} {issue.parent.title}
            </button>
          )}
          <section className="flex flex-col gap-2 border-t pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Subissues</h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canWrite}
                onClick={() => onSubissue(issue.id, issue.team.id)}
              >
                Add subissue
              </Button>
            </div>
            {issue.children.nodes.map((child) => (
              <button
                type="button"
                className="rounded border p-2 text-left text-sm hover:bg-accent"
                key={child.id}
                onClick={() => onOpen(child.id)}
              >
                <span className="mr-2 text-muted-foreground">{child.identifier}</span>
                {child.title}
                <span className="ml-2 text-xs text-muted-foreground">{child.state.name}</span>
              </button>
            ))}
            {issue.children.pageInfo.hasNextPage && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onViewSubissues(issue.id, issue.team.id)}
              >
                View all subissues
              </Button>
            )}
          </section>
          <IssueLinks
            environmentId={environmentId}
            issue={issue}
            mutate={mutate}
            canWrite={canWrite}
            onOpen={onOpen}
          />
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite}
              onClick={() =>
                void mutate({
                  kind: issue.archivedAt ? "issueUnarchive" : "issueArchive",
                  id: issue.id,
                })
              }
            >
              {issue.archivedAt ? "Restore issue" : "Archive issue"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(issue.branchName);
              }}
            >
              Copy branch name
            </Button>
          </div>
          <IssueComments
            key={issue.id}
            environmentId={environmentId}
            issue={issue}
            viewerId={workspace.viewer.id}
            mutate={mutate}
            canWrite={canWrite}
          />
        </>
      ) : null}
      {context.error && (
        <p role="alert" className="text-sm text-destructive">
          {context.error}
        </p>
      )}
    </div>
  );
}
function IssueEditor({
  environmentId,
  issue,
  teamId,
  parentId,
  workspace,
  mutate,
  canWrite,
  onCancel,
  onSaved,
}: {
  environmentId: EnvironmentId;
  issue: LinearIssueDetail | undefined;
  teamId: string | undefined;
  parentId: string | undefined;
  workspace: Workspace;
  mutate: LinearMutate;
  canWrite: boolean;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [baseline] = useState(issue);
  const [team, setTeam] = useState(teamId ?? workspace.teams[0]?.id ?? "");
  const [title, setTitle] = useState(issue?.title ?? "");
  const [description, setDescription] = useState(issue?.description ?? "");
  const [stateId, setStateId] = useState(issue?.state.id ?? "");
  const [assigneeId, setAssigneeId] = useState(issue?.assignee?.id ?? "");
  const [projectId, setProjectId] = useState(issue?.project?.id ?? "");
  const [cycleId, setCycleId] = useState(issue?.cycle?.id ?? "");
  const [priority, setPriority] = useState(String(issue?.priority ?? 0));
  const [estimate, setEstimate] = useState(issue?.estimate?.toString() ?? "");
  const [dueDate, setDueDate] = useState(issue?.dueDate ?? "");
  const [parent, setParent] = useState(parentId ?? issue?.parent?.id ?? "");
  const [labels, setLabels] = useState<ReadonlyArray<string>>(
    issue?.labels.nodes.map((label) => label.id) ?? [],
  );
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const context = useEnvironmentQuery(
    team ? linearEnvironment.teamContext({ environmentId, input: { id: team } }) : null,
  );
  const data = context.data;
  const save = async () => {
    if (uploading || saving || !canWrite) return;
    setSaving(true);
    const fields = {
      ...(title !== baseline?.title ? { title: title.trim() } : {}),
      ...(description !== (baseline?.description ?? "") ? { description } : {}),
      ...(stateId && stateId !== baseline?.state.id ? { stateId } : {}),
      ...(assigneeId !== (baseline?.assignee?.id ?? "") ? { assigneeId: assigneeId || null } : {}),
      ...(projectId !== (baseline?.project?.id ?? "") ? { projectId: projectId || null } : {}),
      ...(cycleId !== (baseline?.cycle?.id ?? "") ? { cycleId: cycleId || null } : {}),
      ...(Number(priority) !== (baseline?.priority ?? 0) ? { priority: Number(priority) } : {}),
      ...(estimate !== (baseline?.estimate?.toString() ?? "")
        ? { estimate: estimate ? Number(estimate) : null }
        : {}),
      ...(dueDate !== (baseline?.dueDate ?? "") ? { dueDate: dueDate || null } : {}),
      ...(parent !== (baseline?.parent?.id ?? "") ? { parentId: parent || null } : {}),
      ...(JSON.stringify([...labels].sort()) !==
      JSON.stringify(baseline?.labels.nodes.map((label) => label.id).sort() ?? [])
        ? { labelIds: labels }
        : {}),
    };
    const result = await mutate(
      issue
        ? { kind: "issueUpdate", id: issue.id, input: fields }
        : {
            kind: "issueCreate",
            input: { ...fields, title: title.trim(), description, teamId: team },
          },
    );
    setSaving(false);
    if (result?.success && (result.id || issue?.id)) onSaved(result.id ?? issue!.id);
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!issue && (
        <LinearSelect
          label="Team"
          value={team}
          options={workspace.teams}
          disabled={saving}
          onChange={(value) => {
            setTeam(value);
            setStateId("");
            setLabels([]);
            setCycleId("");
            setProjectId("");
          }}
          empty="Select team"
        />
      )}
      <label className="flex flex-col gap-1 text-xs">
        Title
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          autoFocus
          disabled={saving}
        />
      </label>
      <div className="flex items-center justify-between text-xs">
        <span>Description · Markdown supported</span>
        <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)}>
          {preview ? "Write" : "Preview"}
        </Button>
      </div>
      {preview ? (
        <LinearMarkdown text={description} />
      ) : (
        <Textarea
          aria-label="Issue description"
          rows={8}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={saving}
        />
      )}
      <LinearUpload
        environmentId={environmentId}
        disabled={!canWrite || saving}
        onPendingChange={setUploading}
        onUploaded={(file) => setDescription((text) => `${text}\n\n${linearFileMarkdown(file)}`)}
      />
      <div className="grid grid-cols-2 gap-3">
        <LinearSelect
          label="Status"
          value={stateId}
          options={data?.states ?? []}
          onChange={setStateId}
          empty="Default status"
          disabled={saving}
        />
        <LinearSelect
          label="Assignee"
          value={assigneeId}
          options={workspace.users}
          onChange={setAssigneeId}
          empty="Unassigned"
          disabled={saving}
        />
        <LinearSelect
          label="Priority"
          value={priority}
          options={["No priority", "Urgent", "High", "Medium", "Low"].map((name, id) => ({
            id: String(id),
            name,
          }))}
          onChange={(value) => setPriority(value || "0")}
          empty="No priority"
          disabled={saving}
        />
        <LinearSelect
          label="Project"
          value={projectId}
          options={data?.projects ?? []}
          onChange={setProjectId}
          empty="No project"
          disabled={saving}
        />
        <LinearSelect
          label="Cycle"
          value={cycleId}
          options={
            data?.cycles.map((cycle) => ({
              id: cycle.id,
              name: cycle.name ?? `Cycle ${cycle.number}`,
            })) ?? []
          }
          onChange={setCycleId}
          empty="No cycle"
          disabled={saving}
        />
        <label className="flex flex-col gap-1 text-xs">
          Due date
          <Input
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Estimate
          <Input
            type="number"
            min="0"
            step="any"
            value={estimate}
            onChange={(event) => setEstimate(event.target.value)}
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Parent issue ID
          <Input
            placeholder="e.g. SEAT-123"
            value={parent}
            onChange={(event) => setParent(event.target.value)}
            disabled={saving}
          />
        </label>
      </div>
      <fieldset disabled={saving} className="flex flex-wrap gap-2">
        <legend className="mb-2 text-xs">Labels</legend>
        {data?.labels.map((label) => (
          <label
            key={label.id}
            className="flex items-center gap-1 rounded border px-2 py-1 text-xs"
          >
            <input
              type="checkbox"
              checked={labels.includes(label.id)}
              onChange={(event) =>
                setLabels(
                  event.target.checked
                    ? [...labels, label.id]
                    : labels.filter((id) => id !== label.id),
                )
              }
            />
            {label.name}
          </label>
        ))}
      </fieldset>
      {context.error && (
        <p role="alert" className="text-sm text-destructive">
          {context.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={!canWrite || saving || uploading || !title.trim() || !team || context.isPending}
        >
          {saving ? "Saving…" : issue ? "Save changes" : "Create issue"}
        </Button>
      </div>
    </form>
  );
}
function IssueComments({
  environmentId,
  issue,
  viewerId,
  mutate,
  canWrite,
}: {
  environmentId: EnvironmentId;
  issue: LinearIssueDetail;
  viewerId: string;
  mutate: LinearMutate;
  canWrite: boolean;
}) {
  const [cursors, setCursors] = useState<Array<string>>([]);
  const after = cursors.at(-1);
  const comments = useEnvironmentQuery(
    linearEnvironment.comments({
      environmentId,
      input: { id: issue.id, ...(after ? { after } : {}) },
    }),
  );
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const result = await mutate(
      editingId
        ? { kind: "commentUpdate", id: editingId, input: { body } }
        : { kind: "commentCreate", input: { issueId: issue.id, body } },
    );
    setBusy(false);
    if (result) {
      setBody("");
      setEditingId(null);
      comments.refresh();
    }
  };
  return (
    <section className="flex flex-col gap-4 border-t pt-4">
      <h3 className="text-sm font-medium">Discussion</h3>
      {comments.error && <LinearMessage retry={comments.refresh}>{comments.error}</LinearMessage>}
      {(comments.data?.nodes ?? issue.comments.nodes).map((comment) => (
        <article className="rounded-lg border p-3" key={comment.id}>
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <strong>{comment.user?.name ?? "Linear"}</strong>
            <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
            {comment.user?.id === viewerId && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canWrite || busy}
                onClick={() => {
                  setEditingId(comment.id);
                  setBody(comment.body);
                }}
              >
                Edit
              </Button>
            )}
          </div>
          <LinearMarkdown text={comment.body} />
        </article>
      ))}
      <LinearPager
        after={after}
        hasNextPage={comments.data?.pageInfo.hasNextPage ?? false}
        pending={comments.isPending}
        onPrevious={() => setCursors((values) => values.slice(0, -1))}
        onNext={() => {
          const cursor = comments.data?.pageInfo.endCursor;
          if (cursor) setCursors((values) => [...values, cursor]);
        }}
      />
      <LinearUpload
        environmentId={environmentId}
        disabled={!canWrite || busy}
        onUploaded={(file) => setBody((text) => `${text}\n\n${linearFileMarkdown(file)}`)}
      />
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Textarea
          aria-label={editingId ? "Edit comment" : "Write a comment"}
          placeholder="Write a comment… Markdown supported"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={!canWrite || busy}
        />
        <div className="flex justify-end gap-2">
          {editingId && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditingId(null);
                setBody("");
              }}
            >
              Cancel edit
            </Button>
          )}
          <Button size="sm" type="submit" disabled={!canWrite || busy || !body.trim()}>
            {busy ? "Saving…" : editingId ? "Save comment" : "Comment"}
          </Button>
        </div>
      </form>
    </section>
  );
}
function IssueLinks({
  environmentId,
  issue,
  mutate,
  canWrite,
  onOpen,
}: {
  environmentId: EnvironmentId;
  issue: LinearIssueDetail;
  mutate: LinearMutate;
  canWrite: boolean;
  onOpen: (id: string) => void;
}) {
  const [related, setRelated] = useState("");
  const [relation, setRelation] = useState("related");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  return (
    <>
      <section className="flex flex-col gap-2 border-t pt-4">
        <h3 className="text-sm font-medium">Relationships</h3>
        {[
          ...issue.relations.nodes.map((item) => ({
            ...item,
            target: item.relatedIssue,
            label: item.type,
          })),
          ...issue.inverseRelations.nodes.map((item) => ({
            ...item,
            target: item.issue,
            label: item.type === "blocks" ? "blocked by" : item.type,
          })),
        ].map((item) => (
          <div key={item.id} className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{item.label}</span>
            <button
              type="button"
              className="flex-1 text-left hover:underline"
              onClick={() => onOpen(item.target.id)}
            >
              {item.target.identifier} {item.target.title}
            </button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove relation to ${item.target.identifier}`}
              disabled={!canWrite}
              onClick={() => void mutate({ kind: "issueRelationDelete", id: item.id })}
            >
              Remove
            </Button>
          </div>
        ))}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const type = relation === "blocks" || relation === "duplicate" ? relation : "related";
            void mutate({
              kind: "issueRelationCreate",
              input: { issueId: issue.id, relatedIssueId: related, type },
            }).then((result) => {
              if (result) setRelated("");
            });
          }}
        >
          <LinearSelect
            label="Relationship"
            value={relation}
            onChange={setRelation}
            options={[
              { id: "related", name: "Related to" },
              { id: "blocks", name: "Blocks" },
              { id: "duplicate", name: "Duplicate of" },
            ]}
          />
          <div className="min-w-28 flex-1">
            <Input
              aria-label="Related issue ID"
              placeholder="SEAT-123"
              value={related}
              onChange={(event) => setRelated(event.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={!canWrite || !related.trim()}>
            Link
          </Button>
        </form>
      </section>
      <section className="flex flex-col gap-2 border-t pt-4">
        <h3 className="text-sm font-medium">Attachments and links</h3>
        <LinearUpload
          environmentId={environmentId}
          disabled={!canWrite}
          onUploaded={async (file) => {
            await mutate({
              kind: "attachmentCreate",
              input: { issueId: issue.id, title: file.name, url: file.url },
            });
          }}
        />
        {issue.attachments.nodes.map((attachment) => (
          <div key={attachment.id} className="flex items-center gap-2">
            <a
              className="min-w-0 flex-1 truncate text-sm text-primary hover:underline"
              href={/^https?:\/\//i.test(attachment.url) ? attachment.url : undefined}
              target="_blank"
              rel="noreferrer"
            >
              {attachment.title}
            </a>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canWrite}
              onClick={() => void mutate({ kind: "attachmentDelete", id: attachment.id })}
            >
              Remove
            </Button>
          </div>
        ))}
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate({
              kind: "attachmentCreate",
              input: { issueId: issue.id, title: title || url, url },
            }).then((result) => {
              if (result) {
                setTitle("");
                setUrl("");
              }
            });
          }}
        >
          <Input
            aria-label="Link title"
            placeholder="Link title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                aria-label="Attachment URL"
                type="url"
                placeholder="https://…"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={!canWrite || !/^https?:\/\//i.test(url)}>
              Add link
            </Button>
          </div>
        </form>
      </section>
    </>
  );
}
