import {
  CommandId,
  type BotCollection,
  type BotProfile,
  type BotWorkAction,
  type BotWorkRun,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useGT } from "gt-react";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";

import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

type Kind = BotCollection["type"];
const selectClass = "rounded-md border bg-background p-2";

export function SidebarBotWork(props: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<BotProfile>;
  readonly openThread: (thread: ScopedThreadRef) => unknown;
}) {
  const gt = useGT();
  const [open, setOpen] = useState<Kind | null>(null);
  if (props.bots.length === 0) return null;
  return (
    <>
      <div className="flex flex-wrap gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen("channel")}>
          {gt("Channels")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen("workflow")}>
          {gt("Workflows")}
        </Button>
      </div>
      {open && <WorkDialog {...props} kind={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function WorkDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<BotProfile>;
  readonly openThread: (thread: ScopedThreadRef) => unknown;
  readonly kind: Kind;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { kind, environmentId } = props;
  const query = useEnvironmentQuery(serverEnvironment.botWorkLive({ environmentId, input: {} }));
  const collections = query.data?.collections.filter((item) => item.type === kind) ?? [];
  const [selected, setSelected] = useState<CommandId | undefined>();
  const [edit, setEdit] = useState<"new" | "edit" | null>(null);
  const collection = collections.find((item) => item.id === selected) ?? collections[0];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{kind === "channel" ? gt("Bot channels") : gt("Bot workflows")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="flex flex-wrap items-end gap-2">
              {collection && (
                <label className="grid gap-1 text-sm">
                  {kind === "channel" ? gt("Channel") : gt("Workflow")}
                  <select
                    className={selectClass}
                    value={collection.id}
                    onChange={(event) => {
                      setSelected(CommandId.make(event.target.value));
                      setEdit(null);
                    }}
                  >
                    {collections.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Button type="button" variant="outline" onClick={() => setEdit("new")}>
                {kind === "channel" ? gt("New channel") : gt("New workflow")}
              </Button>
              {collection && (
                <Button type="button" variant="ghost" onClick={() => setEdit("edit")}>
                  {gt("Edit")}
                </Button>
              )}
            </div>
            {query.error && (
              <p role="alert" className="text-sm text-destructive">
                {query.error}
              </p>
            )}
            {edit ? (
              <CollectionEditor
                key={edit === "new" ? "new" : collection?.id}
                environmentId={environmentId}
                kind={kind}
                bots={props.bots}
                collection={edit === "edit" ? collection : undefined}
                onSave={(id) => {
                  setSelected(id);
                  setEdit(null);
                }}
                onCancel={() => setEdit(null)}
              />
            ) : collection ? (
              <CollectionRuns
                key={collection.id}
                environmentId={environmentId}
                collection={collection}
                runs={query.data?.runs.filter((run) => run.collectionId === collection.id) ?? []}
                bots={props.bots}
                openThread={props.openThread}
              />
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function CollectionEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly kind: Kind;
  readonly collection: BotCollection | undefined;
  readonly bots: ReadonlyArray<BotProfile>;
  readonly onSave: (id: CommandId) => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const { collection, kind, environmentId } = props;
  const act = useAtomCommand(serverEnvironment.actOnBotWork);
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      props.bots.some((bot) => bot.projectId === project.id && bot.state !== "archived"),
  );
  const [id] = useState(() => collection?.id ?? CommandId.make(randomUUID()));
  const [title, setTitle] = useState(collection?.title ?? "");
  const [projectId, setProjectId] = useState<ProjectId | undefined>(
    collection?.projectId ?? projects[0]?.id,
  );
  const [members, setMembers] = useState<ReadonlyArray<ThreadId>>(
    collection?.type === "channel" ? collection.members : [],
  );
  const [leader, setLeader] = useState(collection?.type === "channel" ? collection.leader : null);
  const [steps, setSteps] = useState(() =>
    collection?.type === "workflow"
      ? collection.steps.map((step) => ({ ...step, formId: randomUUID() }))
      : [],
  );
  const [busy, setBusy] = useState(false);
  const bots = props.bots.filter((bot) => bot.projectId === projectId && bot.state !== "archived");
  const selectedMembers = bots.filter((bot) => members.includes(bot.threadId));

  async function save() {
    if (!title.trim() || projectId === undefined || busy) return;
    const [firstMember, ...restMembers] = selectedMembers.map((bot) => bot.threadId);
    const [firstStep, ...restSteps] = steps;
    const selection =
      leader !== null && selectedMembers.some((bot) => bot.threadId === leader) ? leader : null;
    const base = { id, title: title.trim(), projectId };
    const input =
      kind === "channel"
        ? firstMember !== undefined
          ? ({
              ...base,
              type: "save_channel",
              members: [firstMember, ...restMembers],
              leader: selection,
            } as const)
          : undefined
        : firstStep !== undefined && steps.every((step) => step.prompt.trim())
          ? ({ ...base, type: "save_workflow", steps: [firstStep, ...restSteps] } as const)
          : undefined;
    if (!input) return;
    setBusy(true);
    const result = await act({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success") props.onSave(id);
  }

  return (
    <form
      className="grid gap-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="grid gap-1 text-sm">
        {gt("Name")}
        <Input
          required
          value={title}
          maxLength={80}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-sm">
        {gt("Project")}
        <select
          className={selectClass}
          value={projectId}
          disabled={collection !== undefined}
          onChange={(event) => {
            setProjectId(projects.find((item) => item.id === event.target.value)?.id);
            setMembers([]);
            setLeader(null);
            setSteps([]);
          }}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </label>
      {kind === "channel" ? (
        <>
          <fieldset className="grid gap-1 text-sm">
            <legend>{gt("Members")}</legend>
            {bots.map((bot) => (
              <label key={bot.threadId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={members.includes(bot.threadId)}
                  onChange={(event) =>
                    setMembers(
                      event.target.checked
                        ? [...members, bot.threadId]
                        : members.filter((id) => id !== bot.threadId),
                    )
                  }
                />
                {bot.name}
              </label>
            ))}
          </fieldset>
          <label className="grid gap-1 text-sm">
            {gt("Leader")}
            <select
              className={selectClass}
              value={leader ?? ""}
              onChange={(event) =>
                setLeader(
                  selectedMembers.find((bot) => bot.threadId === event.target.value)?.threadId ??
                    null,
                )
              }
            >
              <option value="">{gt("No leader")}</option>
              {selectedMembers.map((bot) => (
                <option value={bot.threadId} key={bot.threadId}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <div className="grid gap-2">
          {steps.map((step, index) => (
            <fieldset className="grid gap-2 rounded-md border p-2 text-sm" key={step.formId}>
              <legend>{gt("Step {number}", { number: index + 1 })}</legend>
              <label className="grid gap-1">
                {gt("Bot")}
                <select
                  className={selectClass}
                  value={step.threadId}
                  onChange={(event) => {
                    const bot = bots.find((candidate) => candidate.threadId === event.target.value);
                    if (bot)
                      setSteps(
                        steps.map((item, position) =>
                          position === index ? { ...item, threadId: bot.threadId } : item,
                        ),
                      );
                  }}
                >
                  {bots.map((bot) => (
                    <option key={bot.threadId} value={bot.threadId}>
                      {bot.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                {gt("Instructions")}
                <Textarea
                  required
                  rows={3}
                  value={step.prompt}
                  maxLength={8000}
                  onChange={(event) =>
                    setSteps(
                      steps.map((item, position) =>
                        position === index ? { ...item, prompt: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSteps(steps.filter((_, position) => position !== index))}
                >
                  {gt("Remove")}
                </Button>
              </div>
            </fieldset>
          ))}
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={steps.length >= 12 || bots.length === 0}
              onClick={() => {
                const first = bots[0];
                if (first)
                  setSteps([
                    ...steps,
                    { threadId: first.threadId, prompt: "", formId: randomUUID() },
                  ]);
              }}
            >
              {gt("Add step")}
            </Button>
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={props.onCancel}>
          {gt("Cancel")}
        </Button>
        <Button
          type="submit"
          disabled={
            busy || (kind === "channel" ? selectedMembers.length === 0 : steps.length === 0)
          }
        >
          {gt("Save")}
        </Button>
      </div>
    </form>
  );
}

function CollectionRuns(props: {
  readonly environmentId: EnvironmentId;
  readonly collection: BotCollection;
  readonly runs: ReadonlyArray<BotWorkRun>;
  readonly bots: ReadonlyArray<BotProfile>;
  readonly openThread: (thread: ScopedThreadRef) => unknown;
}) {
  const gt = useGT();
  const act = useAtomCommand(serverEnvironment.actOnBotWork);
  const [text, setText] = useState("");
  const [mention, setMention] = useState("");
  const [busy, setBusy] = useState(false);
  const { collection, environmentId } = props;
  const members =
    collection.type === "channel"
      ? props.bots.filter((bot) => collection.members.includes(bot.threadId))
      : [];
  const nameFor = (threadId: string) =>
    props.bots.find((bot) => bot.threadId === threadId)?.name ?? threadId;

  async function run(input: typeof BotWorkAction.Type) {
    if (busy) return;
    setBusy(true);
    const result = await act({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success" && input.type === "start") setText("");
  }

  return (
    <div className="grid gap-3">
      {collection.type === "workflow" && (
        <ol className="grid gap-1 pl-5 text-sm list-decimal">
          {collection.steps.map((step, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- Each row is an immutable step in this definition.
            <li key={index}>
              <strong>{nameFor(step.threadId)}</strong> · {step.prompt}
            </li>
          ))}
        </ol>
      )}
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          const target = members.find((bot) => bot.threadId === mention)?.threadId;
          void run({
            type: "start",
            id: CommandId.make(randomUUID()),
            collectionId: collection.id,
            text: text.trim(),
            ...(target === undefined ? {} : { mention: target }),
          });
        }}
      >
        {collection.type === "channel" && (
          <label className="grid gap-1 text-sm">
            {gt("Send to")}
            <select
              className={selectClass}
              value={mention}
              onChange={(event) => setMention(event.target.value)}
            >
              <option value="">{gt("Channel leader")}</option>
              {members.map((bot) => (
                <option key={bot.threadId} value={bot.threadId}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="grid gap-1 text-sm">
          {collection.type === "channel" ? gt("Message") : gt("Workflow input")}
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            required
            rows={3}
            maxLength={12000}
          />
        </label>
        <div>
          <Button
            type="submit"
            disabled={
              busy || !text.trim() || (collection.type === "workflow" && !collection.enabled)
            }
          >
            {collection.type === "channel" ? gt("Send") : gt("Run workflow")}
          </Button>
        </div>
      </form>
      {props.runs.map((work) => (
        <article key={work.id} className="grid gap-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {work.rootId === work.id ? gt("Request") : gt("Assignment")}
              {work.targetThreadId && ` · ${nameFor(work.targetThreadId)}`}
            </span>
            <span>
              {work.status === "waiting"
                ? gt("Waiting")
                : work.status === "running"
                  ? gt("Running")
                  : work.status === "failed"
                    ? gt("Failed")
                    : gt("Completed")}
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">{work.input}</p>
          {work.outputs.map((output) => (
            <div className="border-t pt-1" key={output.runId}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => props.openThread(scopeThreadRef(environmentId, output.threadId))}
              >
                {nameFor(output.threadId)}
              </Button>
              <p className="whitespace-pre-wrap break-words text-sm">{output.text}</p>
            </div>
          ))}
          {work.status === "failed" && (
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(gt("Retry this step? Any external action may be repeated."))) {
                    void run({ type: "retry", id: work.id });
                  }
                }}
              >
                {gt("Retry")}
              </Button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
