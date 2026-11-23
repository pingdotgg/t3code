import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { waitingForUser } from "@t3tools/client-runtime/state/kompas";
import type { ModelSelection, Workstream, WorkstreamLibraryItem } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { BookOpenIcon, FileTextIcon, NotebookPenIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { SidebarInset } from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { requestConfirmDialog } from "../confirmDialog";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { KompasPage, Panel, Progress } from "./KompasPage";
import { MemoryScopePanel } from "./MemoryPage";
import { ModelField, useDefaultModel } from "./ModelField";
import { type Kompas, kompasEnvironment, useKompas, useReportFailure } from "./state";

const MAX_PARALLEL_THREADS = 10;

interface WorkstreamForm {
  readonly title: string;
  readonly goal: string;
  readonly instructions: string;
  readonly threadModel: ModelSelection | null;
  readonly maxParallelThreads: number;
  readonly askBeforeStart: boolean;
}

function WorkstreamFields(props: {
  readonly kompas: Kompas;
  readonly defaultModel: ModelSelection | null;
  readonly form: WorkstreamForm;
  readonly onChange: (form: WorkstreamForm) => void;
}) {
  const { form } = props;
  const set = (patch: Partial<WorkstreamForm>) => props.onChange({ ...form, ...patch });
  const threadModel = form.threadModel ?? props.defaultModel;
  return (
    <>
      <label className="flex flex-col gap-1.5 text-sm">
        <T>Name</T>
        <Input value={form.title} onChange={(event) => set({ title: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <T>Goal</T>
        <Textarea
          rows={2}
          value={form.goal}
          onChange={(event) => set({ goal: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <T>How to work</T>
        <Textarea
          rows={3}
          value={form.instructions}
          onChange={(event) => set({ instructions: event.target.value })}
        />
      </label>
      {threadModel === null ? null : (
        <div className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">
            <T>Model for the project's threads</T>
          </span>
          <ModelField
            environmentId={props.kompas.environmentId}
            value={threadModel}
            onChange={(selection) => set({ threadModel: selection })}
          />
        </div>
      )}
      <label className="flex flex-col gap-1.5 text-sm">
        <T>Threads working at once</T>
        <Input
          type="number"
          min={1}
          max={MAX_PARALLEL_THREADS}
          value={form.maxParallelThreads}
          onChange={(event) =>
            set({
              maxParallelThreads: Math.min(
                MAX_PARALLEL_THREADS,
                Math.max(1, Math.round(event.target.valueAsNumber) || 1),
              ),
            })
          }
        />
      </label>
      <label className="flex items-center gap-3 text-sm">
        <Checkbox
          checked={form.askBeforeStart}
          onCheckedChange={(checked) => set({ askBeforeStart: checked === true })}
        />
        <T>Ask me before a thread starts</T>
      </label>
    </>
  );
}

function NewWorkstreamDialog(props: { readonly kompas: Kompas; readonly onClose: () => void }) {
  const navigate = useNavigate();
  const reportFailure = useReportFailure();
  const defaultModel = useDefaultModel(props.kompas.environmentId);
  const create = useAtomCommand(kompasEnvironment.createWorkstream, { reportFailure: false });
  const [coordinator, setCoordinator] = useState<ModelSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<WorkstreamForm>({
    title: "",
    goal: "",
    instructions: "",
    threadModel: null,
    maxParallelThreads: 3,
    askBeforeStart: true,
  });
  const coordinatorModel = coordinator ?? defaultModel;
  const submit = async () => {
    if (coordinatorModel === null) return;
    setBusy(true);
    const { environmentId } = props.kompas;
    const result = await create({ environmentId, input: { ...form, coordinatorModel } });
    setBusy(false);
    if (!reportFailure(result) || result._tag !== "Success") return;
    props.onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(environmentId, result.value.coordinatorThreadId),
      ),
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>New project</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <WorkstreamFields
              kompas={props.kompas}
              defaultModel={defaultModel}
              form={form}
              onChange={setForm}
            />
            {coordinatorModel === null ? (
              <p className="text-muted-foreground text-sm">
                <T>Sign in to a provider in Settings first.</T>
              </p>
            ) : (
              <div className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">
                  <T>Coordinator's model</T>
                </span>
                <ModelField
                  environmentId={props.kompas.environmentId}
                  value={coordinatorModel}
                  onChange={setCoordinator}
                />
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            disabled={busy || coordinatorModel === null || form.title.trim() === ""}
            onClick={() => void submit()}
          >
            <T>Create project</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function useProgressLabel() {
  const gt = useGT();
  return (workstream: Workstream) =>
    gt("{done} of {total} threads done", {
      done: workstream.threads.filter((thread) => thread.state === "resolved").length,
      total: workstream.threads.length,
    });
}

const workstreamProgress = ({ threads }: Workstream) =>
  threads.length === 0
    ? 0
    : threads.filter((thread) => thread.state === "resolved").length / threads.length;

export function WorkstreamsPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const kompas = useKompas();
  const progressLabel = useProgressLabel();
  const [creating, setCreating] = useState(false);
  if (kompas === null) return <SidebarInset className="h-dvh" />;
  const { workstreams } = kompas.snapshot;
  return (
    <KompasPage
      title={gt("Projects")}
      description={gt("One coordinator talks with you; its threads do the work.")}
      actions={
        <Button onClick={() => setCreating(true)}>
          <PlusIcon />
          <T>New project</T>
        </Button>
      }
    >
      {workstreams.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              <T>No projects yet</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>Start one for something larger: exam prep, a thesis, a trip.</T>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {workstreams.map((workstream) => {
            const waiting = waitingForUser(workstream);
            return (
              <Panel key={workstream.id} className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="min-w-0 truncate font-semibold text-base">{workstream.title}</h2>
                  {waiting === 0 ? null : (
                    <Badge variant="warning">
                      <T>
                        Waiting for you: <Var>{waiting}</Var>
                      </T>
                    </Badge>
                  )}
                </div>
                <p className="line-clamp-2 text-muted-foreground text-sm">{workstream.goal}</p>
                <div className="flex items-center gap-3 text-muted-foreground text-sm">
                  <Progress
                    value={workstreamProgress(workstream)}
                    label={progressLabel(workstream)}
                  />
                  {progressLabel(workstream)}
                </div>
                <div>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(kompas.environmentId, workstream.coordinatorThreadId),
                        ),
                      })
                    }
                  >
                    <T>Open project</T>
                  </Button>
                </div>
              </Panel>
            );
          })}
        </div>
      )}
      {creating ? <NewWorkstreamDialog kompas={kompas} onClose={() => setCreating(false)} /> : null}
    </KompasPage>
  );
}

function Overview(props: {
  readonly kompas: Kompas;
  readonly workstream: Workstream;
  readonly threadId: string;
}) {
  const { workstream } = props;
  const gt = useGT();
  const reportFailure = useReportFailure();
  const progressLabel = useProgressLabel();
  const { environmentId } = props.kompas;
  const answerDecision = useAtomCommand(kompasEnvironment.answerDecision, { reportFailure: false });
  const resolveSuggestion = useAtomCommand(kompasEnvironment.resolveSuggestion, {
    reportFailure: false,
  });
  const setResolved = useAtomCommand(kompasEnvironment.setThreadResolved, { reportFailure: false });
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const thread = workstream.threads.find((entry) => entry.threadId === props.threadId);
  const answer = (id: string, text: string) =>
    void answerDecision({ environmentId, input: { id, answer: text } }).then(reportFailure);
  const resolve = (id: string, approve: boolean) =>
    void resolveSuggestion({ environmentId, input: { id, approve } }).then(reportFailure);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1.5 text-muted-foreground text-sm">{progressLabel(workstream)}</p>
        <div className="flex">
          <Progress value={workstreamProgress(workstream)} label={progressLabel(workstream)} />
        </div>
      </div>
      {workstream.decisions.map((decision) => (
        <Panel key={decision.id}>
          <p className="font-medium text-primary text-sm">
            <T>Decide</T>
          </p>
          <p className="mt-1 wrap-anywhere">{decision.question}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {decision.options.map((option) => (
              <Button
                key={option}
                size="sm"
                variant="outline"
                onClick={() => answer(decision.id, option)}
              >
                {option}
              </Button>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Input
              aria-label={gt("Your own answer")}
              placeholder={gt("Your own answer")}
              value={answers[decision.id] ?? ""}
              onChange={(event) => setAnswers({ ...answers, [decision.id]: event.target.value })}
            />
            <Button
              disabled={(answers[decision.id] ?? "").trim() === ""}
              onClick={() => answer(decision.id, answers[decision.id] ?? "")}
            >
              <T>Answer</T>
            </Button>
          </div>
        </Panel>
      ))}
      {workstream.suggestions.map((suggestion) => (
        <Panel key={suggestion.id}>
          <p className="font-medium text-primary text-sm">
            <T>Proposed thread</T>
          </p>
          <p className="mt-1 font-medium wrap-anywhere">{suggestion.title}</p>
          <p className="mt-1 line-clamp-4 text-muted-foreground text-sm">{suggestion.task}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => resolve(suggestion.id, true)}>
              <T>Start</T>
            </Button>
            <Button size="sm" variant="outline" onClick={() => resolve(suggestion.id, false)}>
              <T>Dismiss</T>
            </Button>
          </div>
        </Panel>
      ))}
      {thread === undefined || thread.state === "working" ? null : (
        <Button
          variant="outline"
          onClick={() =>
            void setResolved({
              environmentId,
              input: {
                workstreamId: workstream.id,
                threadId: thread.threadId,
                resolved: thread.state !== "resolved",
              },
            }).then(reportFailure)
          }
        >
          {thread.state === "resolved" ? <T>Reopen this thread</T> : <T>Mark this thread done</T>}
        </Button>
      )}
      {workstream.goal === "" ? null : (
        <div>
          <p className="font-medium text-sm">
            <T>Goal</T>
          </p>
          <p className="text-muted-foreground text-sm wrap-anywhere">{workstream.goal}</p>
        </div>
      )}
    </div>
  );
}

const LIBRARY_ICONS = { file: FileTextIcon, deck: BookOpenIcon, note: NotebookPenIcon };

function LibraryRow(props: { readonly kompas: Kompas; readonly item: WorkstreamLibraryItem }) {
  const { item } = props;
  const gt = useGT();
  const navigate = useNavigate();
  const reportFailure = useReportFailure();
  const remove = useAtomCommand(kompasEnvironment.removeLibraryItem, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const Icon = LIBRARY_ICONS[item.kind];
  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
          onClick={() =>
            item.kind === "deck"
              ? void navigate({ to: "/study", search: { session: item.content } })
              : setOpen(!open)
          }
        >
          {item.title}
        </button>
        <Button
          size="icon-sm"
          variant="ghost-destructive"
          aria-label={gt("Remove {title}", { title: item.title })}
          onClick={() =>
            void remove({
              environmentId: props.kompas.environmentId,
              input: { id: item.id },
            }).then(reportFailure)
          }
        >
          <Trash2Icon />
        </Button>
      </div>
      {open ? (
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground text-sm wrap-anywhere">
          {item.content}
        </p>
      ) : null}
    </li>
  );
}

function Library(props: { readonly kompas: Kompas; readonly workstream: Workstream }) {
  const gt = useGT();
  const reportFailure = useReportFailure();
  const add = useAtomCommand(kompasEnvironment.addLibraryItem, { reportFailure: false });
  const [draft, setDraft] = useState<{ kind: "file" | "note"; title: string; content: string }>({
    kind: "note",
    title: "",
    content: "",
  });
  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-border">
        {props.workstream.library.map((item) => (
          <LibraryRow key={item.id} kompas={props.kompas} item={item} />
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        <ToggleGroup
          value={[draft.kind]}
          onValueChange={([kind]) => {
            if (kind === "file" || kind === "note") setDraft({ ...draft, kind });
          }}
        >
          <Toggle value="note">
            <T>Note</T>
          </Toggle>
          <Toggle value="file">
            <T>File</T>
          </Toggle>
        </ToggleGroup>
        <Input
          placeholder={gt("Title")}
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
        {draft.kind === "note" ? (
          <Textarea
            rows={3}
            placeholder={gt("Note")}
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
        ) : (
          <Input
            placeholder={gt("File path on this computer")}
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
        )}
        <Button
          variant="outline"
          disabled={draft.title.trim() === "" || draft.content.trim() === ""}
          onClick={() =>
            void add({
              environmentId: props.kompas.environmentId,
              input: { workstreamId: props.workstream.id, ...draft },
            }).then((result) => {
              if (reportFailure(result)) setDraft({ ...draft, title: "", content: "" });
            })
          }
        >
          <PlusIcon />
          <T>Add to library</T>
        </Button>
      </div>
    </div>
  );
}

function WorkstreamSettings(props: { readonly kompas: Kompas; readonly workstream: Workstream }) {
  const { workstream } = props;
  const gt = useGT();
  const navigate = useNavigate();
  const reportFailure = useReportFailure();
  const { environmentId } = props.kompas;
  const update = useAtomCommand(kompasEnvironment.updateWorkstream, { reportFailure: false });
  const remove = useAtomCommand(kompasEnvironment.removeWorkstream, { reportFailure: false });
  const defaultModel = useDefaultModel(environmentId);
  const [form, setForm] = useState<WorkstreamForm>({
    title: workstream.title,
    goal: workstream.goal,
    instructions: workstream.instructions,
    threadModel: workstream.threadModel,
    maxParallelThreads: workstream.maxParallelThreads,
    askBeforeStart: workstream.askBeforeStart,
  });
  const removeProject = async () => {
    const confirmed = await requestConfirmDialog(
      gt("Delete {title}? Its threads stay in your conversations.", { title: workstream.title }),
    );
    if (confirmed !== true) return;
    if (reportFailure(await remove({ environmentId, input: { id: workstream.id } }))) {
      void navigate({ to: "/workstreams" });
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <WorkstreamFields
        kompas={props.kompas}
        defaultModel={defaultModel}
        form={form}
        onChange={setForm}
      />
      <Button
        disabled={form.title.trim() === ""}
        onClick={() =>
          void update({ environmentId, input: { id: workstream.id, ...form } }).then(reportFailure)
        }
      >
        <T>Save</T>
      </Button>
      <Button variant="destructive-outline" onClick={() => void removeProject()}>
        <T>Delete project</T>
      </Button>
    </div>
  );
}

const PANEL_TABS = ["overview", "library", "memory", "settings"] as const;

/** Beside a project's conversation: what it needs from the user, its materials and its memory. */
export function WorkstreamPanel(props: {
  readonly kompas: Kompas;
  readonly workstream: Workstream;
  readonly threadId: string;
}) {
  const { kompas, workstream } = props;
  const gt = useGT();
  const [tab, setTab] = useState<(typeof PANEL_TABS)[number]>("overview");
  const labels = {
    overview: gt("Overview"),
    library: gt("Library"),
    memory: gt("Memory"),
    settings: gt("Settings"),
  };
  return (
    <aside
      aria-label={gt("Project")}
      className="flex w-80 shrink-0 flex-col border-border border-l bg-background max-lg:hidden"
    >
      <div className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center overflow-x-auto px-3">
        <ToggleGroup
          size="sm"
          value={[tab]}
          onValueChange={([picked]) => {
            const next = PANEL_TABS.find((entry) => entry === picked);
            if (next !== undefined) setTab(next);
          }}
        >
          {PANEL_TABS.map((entry) => (
            <Toggle key={entry} value={entry}>
              {labels[entry]}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "overview" ? (
          <Overview kompas={kompas} workstream={workstream} threadId={props.threadId} />
        ) : tab === "library" ? (
          <Library kompas={kompas} workstream={workstream} />
        ) : tab === "memory" ? (
          <MemoryScopePanel
            kompas={kompas}
            scope={`project:${workstream.id}`}
            title={gt("Project memory")}
            detail={gt("Only this project's threads see it")}
          />
        ) : (
          <WorkstreamSettings key={workstream.id} kompas={kompas} workstream={workstream} />
        )}
      </div>
    </aside>
  );
}
