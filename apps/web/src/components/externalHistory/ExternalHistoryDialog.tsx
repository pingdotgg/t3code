import { useAtomValue } from "@effect/atom-react";
import { externalHistoryRangeLabel } from "@t3tools/client-runtime/externalHistory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ExternalHistoryMatch,
  ExternalHistoryRequest,
  ExternalHistorySettings,
} from "@t3tools/contracts";
import { useState } from "react";

import { externalHistory } from "../../state/externalHistory";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

type Search = Extract<ExternalHistoryRequest, { operation: "search" }>;

export function ExternalHistoryButton(props: {
  readonly environmentId: EnvironmentId;
  readonly currentProjectPath?: string;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (config?.environment.capabilities.externalHistory !== 1) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {props.label ?? "External history"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>External history</DialogTitle>
            <DialogDescription>
              Search Codex conversations and configured ChatGPT exports on this environment. Open
              the original evidence behind each match.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {open ? <ExternalHistoryPanel key={props.environmentId} {...props} /> : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function ExternalHistorySettingsEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: ExternalHistorySettings;
}) {
  const canWrite = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [paths, setPaths] = useState(props.settings.chatGptExportPaths.join("\n"));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (settings: ExternalHistorySettings) => {
    if (pending || !canWrite) return;
    setPending(true);
    setError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: { patch: { externalHistory: settings } },
    });
    setPending(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <section
      className="flex flex-col gap-3 rounded-md border p-3"
      aria-label="External history settings"
    >
      <div className="flex items-center justify-between gap-3 text-sm font-medium">
        <span>Allow external history search</span>
        <Switch
          aria-label="Allow external history search"
          checked={props.settings.enabled}
          disabled={pending || !canWrite}
          onCheckedChange={(enabled) => void save({ ...props.settings, enabled })}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Makes these sources available to this environment's connected clients and agents with thread
        access. Source files stay in their existing locations.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span>ChatGPT export paths</span>
        <Textarea
          aria-label="ChatGPT export paths"
          rows={3}
          value={paths}
          disabled={pending || !canWrite}
          onChange={(event) => setPaths(event.target.value)}
          placeholder="One export file path per line"
        />
      </label>
      <p className="text-muted-foreground text-xs">
        Paths refer to files on the T3 server, including when you connect remotely. Remove a path to
        stop offering that export.
      </p>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !canWrite || paths === props.settings.chatGptExportPaths.join("\n")}
          onClick={() =>
            void save({
              ...props.settings,
              chatGptExportPaths: [
                ...new Set(
                  paths
                    .split("\n")
                    .map((path) => path.trim())
                    .filter(Boolean),
                ),
              ],
            })
          }
        >
          Save export paths
        </Button>
      </div>
      {!canWrite ? (
        <p className="text-muted-foreground text-xs">
          This connection cannot change environment settings.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ExternalHistoryPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly currentProjectPath?: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (config?.environment.capabilities.externalHistory !== 1)
    return (
      <p className="text-muted-foreground text-sm">
        Update this server to search external history.
      </p>
    );
  const settings = config.settings.externalHistory;
  return (
    <div className="flex flex-col gap-4">
      <ExternalHistorySettingsEditor
        key={"settings:" + JSON.stringify(settings.chatGptExportPaths)}
        environmentId={props.environmentId}
        settings={settings}
      />
      {settings.enabled ? (
        <HistorySources key={"sources:" + JSON.stringify(settings)} {...props} />
      ) : (
        <p className="text-muted-foreground text-sm">
          External history search is off for this environment.
        </p>
      )}
    </div>
  );
}

function HistorySources(props: {
  readonly environmentId: EnvironmentId;
  readonly currentProjectPath?: string;
}) {
  const query = useEnvironmentQuery(
    externalHistory.query({ environmentId: props.environmentId, input: { operation: "sources" } }),
  );
  const [selected, setSelected] = useState<string | null>(null);
  if (query.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {query.error}
      </p>
    );
  if (!query.data || query.data.operation !== "sources")
    return <p className="text-muted-foreground text-sm">Loading history sources…</p>;
  if (!query.data.enabled)
    return (
      <p className="text-muted-foreground text-sm">
        External history search is off for this environment.
      </p>
    );
  const sources = query.data.sources;
  const source = sources.find((item) => item.id === selected) ?? sources[0];
  if (!source)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm">
          No sources are configured. Enable a Codex provider or add a ChatGPT export path.
        </p>
        <div>
          <Button size="sm" variant="outline" onClick={query.refresh} disabled={query.isPending}>
            Refresh sources
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <Select value={source.id} onValueChange={setSelected}>
        <SelectTrigger aria-label="History source">
          <SelectValue>{source.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {sources.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <HistorySearch
        key={source.id}
        {...props}
        sourceId={source.id}
        codex={source.kind === "codex"}
      />
    </div>
  );
}

function HistorySearch(props: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: string;
  readonly codex: boolean;
  readonly currentProjectPath?: string;
}) {
  const [text, setText] = useState("");
  const [filterCwd, setFilterCwd] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState<Search | null>(null);
  const [generation, setGeneration] = useState(0);
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          setGeneration((current) => current + 1);
          setSearch({
            operation: "search",
            sourceId: props.sourceId,
            query: text.trim(),
            ...(props.codex
              ? { includeArchived, ...(filterCwd.trim() ? { filterCwd: filterCwd.trim() } : {}) }
              : {}),
          });
        }}
      >
        <Input
          aria-label="Search external history"
          placeholder="Find text in messages and tool evidence"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={256}
        />
        {props.codex ? (
          <>
            <Input
              aria-label="History directory filter"
              placeholder="All project directories"
              value={filterCwd}
              onChange={(event) => setFilterCwd(event.target.value)}
              maxLength={4096}
            />
            {props.currentProjectPath ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setFilterCwd(props.currentProjectPath!)}
                >
                  This project
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setFilterCwd("")}>
                  All projects
                </Button>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>Include archived Codex threads</span>
              <Switch
                aria-label="Include archived Codex threads"
                checked={includeArchived}
                onCheckedChange={setIncludeArchived}
              />
            </div>
          </>
        ) : null}
        <div>
          <Button type="submit" size="sm" disabled={!text.trim()}>
            Search
          </Button>
        </div>
      </form>
      {search ? (
        <HistoryResults
          key={JSON.stringify([search, generation])}
          environmentId={props.environmentId}
          search={search}
        />
      ) : (
        <p className="text-muted-foreground text-xs">
          Search reads bounded pages from the selected source. It may take several pages to scan a
          large history.
        </p>
      )}
    </div>
  );
}

function HistoryResults(props: { readonly environmentId: EnvironmentId; readonly search: Search }) {
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const [selected, setSelected] = useState<ExternalHistoryMatch | null>(null);
  const cursor = cursors.at(-1);
  const query = useEnvironmentQuery(
    externalHistory.query({
      environmentId: props.environmentId,
      input: { ...props.search, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
  if (selected)
    return (
      <div className="flex flex-col gap-3">
        <div>
          <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
            Back to matches
          </Button>
        </div>
        <HistorySource
          key={selected.ref.readCursor + selected.ref.digest}
          environmentId={props.environmentId}
          match={selected}
        />
      </div>
    );
  if (query.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {query.error}
      </p>
    );
  if (!query.data || query.data.operation !== "search")
    return <p className="text-muted-foreground text-sm">Searching history…</p>;
  const data = query.data;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">
        Examined {data.examinedItems.toLocaleString()} items on this page.
      </p>
      {data.matches.length === 0 ? (
        <p className="text-sm">
          No matches on this page.
          {data.nextCursor !== null ? " Continue to search the next page." : ""}
        </p>
      ) : null}
      {data.matches.map((match) => (
        <article
          key={match.ref.readCursor + ":" + match.ref.digest}
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <h3 className="text-sm font-medium">{match.threadTitle}</h3>
          <p className="text-muted-foreground text-xs">
            {match.role} · {match.totalChars.toLocaleString()} characters
          </p>
          <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">
            {match.excerpt}
          </p>
          <div>
            <Button size="sm" variant="outline" onClick={() => setSelected(match)}>
              Open source
            </Button>
          </div>
        </article>
      ))}
      {cursors.length > 0 || data.nextCursor !== null ? (
        <div className="flex justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={cursors.length === 0 || query.isPending}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Previous page
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={data.nextCursor === null || query.isPending}
            onClick={() => {
              if (data.nextCursor !== null) setCursors((current) => [...current, data.nextCursor!]);
            }}
          >
            Continue search
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function HistorySource(props: {
  readonly environmentId: EnvironmentId;
  readonly match: ExternalHistoryMatch;
}) {
  const [offsets, setOffsets] = useState<ReadonlyArray<number>>([0]);
  const query = useEnvironmentQuery(
    externalHistory.query({
      environmentId: props.environmentId,
      input: {
        operation: "read",
        ref: props.match.ref,
        textOffset: offsets.at(-1) ?? 0,
        maxChars: 12_000,
      },
    }),
  );
  if (query.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {query.error}
      </p>
    );
  if (!query.data || query.data.operation !== "read")
    return <p className="text-muted-foreground text-sm">Reading source…</p>;
  const data = query.data;
  return (
    <article className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{data.threadTitle}</h3>
      <p className="text-muted-foreground text-xs">
        {data.role} · {externalHistoryRangeLabel(data)}
      </p>
      <p className="break-all text-muted-foreground text-xs">
        Thread {data.ref.threadId} · Item {props.match.itemId}
      </p>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 text-sm">
        {data.text}
      </pre>
      {offsets.length > 1 || data.nextTextOffset !== null ? (
        <div className="flex justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={offsets.length === 1 || query.isPending}
            onClick={() => setOffsets((current) => current.slice(0, -1))}
          >
            Previous source text
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={data.nextTextOffset === null || query.isPending}
            onClick={() => {
              if (data.nextTextOffset !== null)
                setOffsets((current) => [...current, data.nextTextOffset!]);
            }}
          >
            More source text
          </Button>
        </div>
      ) : null}
    </article>
  );
}
