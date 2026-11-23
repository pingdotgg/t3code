import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memoryInScope } from "@t3tools/client-runtime/state/kompas";
import { MEMORY_LIMITS, type MemoryEntry } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useLocale } from "gt-react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { SidebarInset } from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import { useVisibleThreadShells } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatDay, KompasPage, Panel, PanelTitle, Progress } from "./KompasPage";
import { useModelName } from "./ModelField";
import { type Kompas, kompasEnvironment, useKompas, useReportFailure } from "./state";

function EntryEditor(props: {
  readonly kompas: Kompas;
  readonly scope: string;
  readonly entry: MemoryEntry | null;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const reportFailure = useReportFailure();
  const saveMemory = useAtomCommand(kompasEnvironment.saveMemory, { reportFailure: false });
  const removeMemory = useAtomCommand(kompasEnvironment.removeMemory, { reportFailure: false });
  const [text, setText] = useState(props.entry?.text ?? "");
  const { environmentId } = props.kompas;
  return (
    <div className="flex flex-col gap-2 py-3">
      <Textarea
        autoFocus
        rows={2}
        aria-label={gt("Memory entry")}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={text.trim() === ""}
          onClick={() =>
            void saveMemory({
              environmentId,
              input: {
                ...(props.entry === null ? {} : { id: props.entry.id }),
                scope: props.scope,
                text,
              },
            }).then((result) => {
              if (reportFailure(result)) props.onClose();
            })
          }
        >
          <T>Save</T>
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          <T>Cancel</T>
        </Button>
        {props.entry === null ? null : (
          <Button
            size="icon-sm"
            variant="ghost-destructive"
            aria-label={gt("Forget this")}
            onClick={() =>
              void removeMemory({ environmentId, input: { id: props.entry!.id } }).then(
                reportFailure,
              )
            }
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
    </div>
  );
}

export function MemoryScopePanel(props: {
  readonly kompas: Kompas;
  readonly scope: string;
  readonly title: string;
  readonly detail: string;
}) {
  const gt = useGT();
  const locale = useLocale();
  const modelName = useModelName(props.kompas.environmentId);
  const [editing, setEditing] = useState<string | null>(null);
  const { entries, used } = memoryInScope(props.kompas.snapshot, props.scope);
  const limit =
    props.scope === "user" || props.scope === "notes"
      ? MEMORY_LIMITS[props.scope]
      : MEMORY_LIMITS.project;
  return (
    <Panel>
      <PanelTitle detail={props.detail}>{props.title}</PanelTitle>
      <div className="flex items-center gap-3 text-muted-foreground text-sm">
        <Progress value={used / limit} label={gt("Memory used")} />
        <span>
          {used.toLocaleString(locale)} / {limit.toLocaleString(locale)}
        </span>
      </div>
      <ul className="mt-2 divide-y divide-border">
        {entries.map((entry) => (
          <li key={entry.id}>
            {editing === entry.id ? (
              <EntryEditor
                kompas={props.kompas}
                scope={props.scope}
                entry={entry}
                onClose={() => setEditing(null)}
              />
            ) : (
              <div className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="wrap-anywhere">{entry.text}</p>
                  <p className="text-muted-foreground text-sm">
                    {entry.model === null ? gt("You") : modelName(entry.model)} ·{" "}
                    {formatDay(entry.updatedAt, locale)}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={gt("Edit entry")}
                  onClick={() => setEditing(entry.id)}
                >
                  <PencilIcon />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing === "new" ? (
        <EntryEditor
          kompas={props.kompas}
          scope={props.scope}
          entry={null}
          onClose={() => setEditing(null)}
        />
      ) : (
        <Button size="sm" variant="ghost-muted" onClick={() => setEditing("new")}>
          <PlusIcon />
          <T>Add</T>
        </Button>
      )}
    </Panel>
  );
}

function Proposals({ kompas }: { readonly kompas: Kompas }) {
  const gt = useGT();
  const reportFailure = useReportFailure();
  const modelName = useModelName(kompas.environmentId);
  const resolveMemory = useAtomCommand(kompasEnvironment.resolveMemory, { reportFailure: false });
  const { memory } = kompas.snapshot;
  return memory
    .filter((entry) => entry.status === "proposed")
    .map((entry) => {
      const author = entry.model === null ? gt("The model") : modelName(entry.model);
      const replaced = memory.find((candidate) => candidate.id === entry.replacesId);
      const resolve = (approve: boolean) =>
        void resolveMemory({
          environmentId: kompas.environmentId,
          input: { id: entry.id, approve },
        }).then(reportFailure);
      return (
        <section
          key={entry.id}
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-5"
        >
          <div className="min-w-48 flex-1">
            <p className="font-medium text-primary text-sm">
              {entry.text === ""
                ? gt("{model} wants to forget", { model: author })
                : gt("{model} wants to remember", { model: author })}
            </p>
            <p className="wrap-anywhere">{entry.text === "" ? replaced?.text : entry.text}</p>
          </div>
          <Button onClick={() => resolve(true)}>
            <T>Save</T>
          </Button>
          <Button variant="outline" onClick={() => resolve(false)}>
            <T>Reject</T>
          </Button>
        </section>
      );
    });
}

function PastConversations({ kompas }: { readonly kompas: Kompas }) {
  const gt = useGT();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const { matches } = useThreadSearch([kompas.environmentId], query);
  const titles = new Map(useVisibleThreadShells().map((thread) => [thread.id, thread] as const));
  return (
    <Panel>
      <PanelTitle detail={gt('Models search them when you say "remember when…". So can you.')}>
        <T>Past conversations</T>
      </PanelTitle>
      <div>
        <Input
          type="search"
          aria-label={gt("Search past conversations")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {matches.map((match) => (
          <Link
            key={`${match.threadId}:${match.messageId ?? ""}`}
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(scopeThreadRef(match.environmentId, match.threadId))}
            className="rounded-xl bg-muted p-3 hover:bg-accent"
          >
            <p className="font-medium">
              {titles.get(match.threadId)?.title ?? gt("Conversation")}
              {match.messageCreatedAt === null
                ? null
                : ` · ${formatDay(match.messageCreatedAt, locale)}`}
            </p>
            <p className="text-muted-foreground text-sm">{match.snippet}</p>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

export function MemoryPage() {
  const gt = useGT();
  const kompas = useKompas();
  const reportFailure = useReportFailure();
  const updateSettings = useAtomCommand(kompasEnvironment.updateSettings, { reportFailure: false });
  if (kompas === null) return <SidebarInset className="h-dvh" />;
  const { settings, workstreams } = kompas.snapshot;
  const update = (input: Partial<typeof settings>) =>
    void updateSettings({ environmentId: kompas.environmentId, input }).then(reportFailure);
  return (
    <KompasPage
      title={gt("Memory")}
      description={gt(
        "One memory for Claude, GPT and every account. Each model reads it when a conversation starts and adds to it with the same tool.",
      )}
    >
      <Proposals kompas={kompas} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <MemoryScopePanel
          kompas={kompas}
          scope="user"
          title={gt("Profile")}
          detail={gt("Who you are and how you like to talk")}
        />
        <MemoryScopePanel
          kompas={kompas}
          scope="notes"
          title={gt("Assistant notes")}
          detail={gt("Agreements and facts from conversations")}
        />
      </div>
      {workstreams.map((workstream) => (
        <MemoryScopePanel
          key={workstream.id}
          kompas={kompas}
          scope={`project:${workstream.id}`}
          title={workstream.title}
          detail={gt("Only this project's threads see it")}
        />
      ))}
      <PastConversations kompas={kompas} />
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-3 text-sm">
          <Checkbox
            checked={settings.memoryAskBeforeSaving}
            onCheckedChange={(checked) => update({ memoryAskBeforeSaving: checked === true })}
          />
          <T>Ask me before a model remembers something</T>
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Checkbox
            checked={settings.memorySearchEnabled}
            onCheckedChange={(checked) => update({ memorySearchEnabled: checked === true })}
          />
          <T>Let models search past conversations</T>
        </label>
      </div>
    </KompasPage>
  );
}
