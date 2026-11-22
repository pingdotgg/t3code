import { msg, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  externalHistoryPagingReducer,
  initialExternalHistoryPaging,
  externalHistoryRangeLabel,
  externalHistoryRoleLabel,
  externalHistorySearchFilters,
  externalHistorySourceStatusLabel,
} from "@t3tools/client-runtime/externalHistory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ExternalHistoryMatch,
  ExternalHistoryRequest,
  ExternalHistorySettings,
  ExternalHistorySource,
} from "@t3tools/contracts";
import { useEffect, useReducer, useState, type ReactNode } from "react";

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
import { Switch } from "../ui/switch";

type Search = Extract<ExternalHistoryRequest, { operation: "search" }>;

export function ExternalHistoryButton(props: {
  readonly environmentId: EnvironmentId;
  readonly currentProjectPath?: string;
  readonly label?: string;
}) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (config?.environment.capabilities.externalHistory !== 1) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {props.label ?? m(msg("External history"))}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{m(msg("External history"))}</DialogTitle>
            <DialogDescription>
              {m(
                msg(
                  "Search agent conversations found on this environment. Open the original evidence behind each match.",
                ),
              )}
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
  readonly children: ReactNode;
}) {
  const m = useMessages();
  const canWrite = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
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
    <div className="flex flex-col gap-4">
      <section
        className="flex flex-col gap-3 rounded-md border p-3"
        aria-label={m(msg("External history settings"))}
      >
        <div className="flex items-center justify-between gap-3 text-sm font-medium">
          <span>{m(msg("Allow external history search"))}</span>
          <Switch
            aria-label={m(msg("Allow external history search"))}
            checked={props.settings.enabled}
            disabled={pending || !canWrite}
            onCheckedChange={(enabled) => void save({ ...props.settings, enabled })}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {m(
            msg(
              "Makes these sources available to this environment's connected clients and agents with thread access. Source files stay in their existing locations.",
            ),
          )}
        </p>
        {!canWrite ? (
          <p className="text-muted-foreground text-xs">
            {m(msg("This connection cannot change environment settings."))}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </section>
      {props.children}
    </div>
  );
}

function ExternalHistoryPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly currentProjectPath?: string;
}) {
  const m = useMessages();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (config?.environment.capabilities.externalHistory !== 1)
    return (
      <p className="text-muted-foreground text-sm">
        {m(msg("Update this server to search external history."))}
      </p>
    );
  const settings = config.settings.externalHistory;
  return (
    <div className="flex flex-col gap-4">
      <ExternalHistorySettingsEditor environmentId={props.environmentId} settings={settings}>
        {settings.enabled ? (
          <HistorySources key={"sources:" + JSON.stringify(settings)} {...props} />
        ) : (
          <p className="text-muted-foreground text-sm">
            {m(msg("External history search is off for this environment."))}
          </p>
        )}
      </ExternalHistorySettingsEditor>
    </div>
  );
}

function HistorySources(props: {
  readonly environmentId: EnvironmentId;
  readonly currentProjectPath?: string;
}) {
  const m = useMessages();
  const query = useEnvironmentQuery(
    externalHistory.query({
      environmentId: props.environmentId,
      input: { operation: "sources", catalogVersion: 2 },
    }),
  );
  const [selected, setSelected] = useState<string | null>(null);
  if (query.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {query.error}
      </p>
    );
  if (!query.data || query.data.operation !== "sources")
    return <p className="text-muted-foreground text-sm">{m(msg("Loading history sources…"))}</p>;
  if (!query.data.enabled)
    return (
      <p className="text-muted-foreground text-sm">
        {m(msg("External history search is off for this environment."))}
      </p>
    );
  const sources = query.data.sources;
  const source =
    sources.find((item) => item.id === selected && item.status === "ready") ??
    sources.find((item) => item.status === "ready");
  return (
    <div className="flex flex-col gap-3">
      <section aria-label={m(msg("Discovered history sources"))} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{m(msg("Found on this environment"))}</h3>
        {sources.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {m(msg("No local history found. Refresh after adding conversations on this server."))}
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {sources.map((item) => (
            <li key={item.id} className="flex flex-col gap-1">
              <div>
                <Button
                  variant={source?.id === item.id ? "secondary" : "outline"}
                  size="sm-multiline"
                  aria-pressed={source?.id === item.id}
                  disabled={item.status !== "ready"}
                  onClick={() => setSelected(item.id)}
                >
                  <span className="min-w-0 break-all text-left">{item.label}</span>
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                {externalHistorySourceStatusLabel(item.status, m)}
                {item.message ? ` · ${item.message}` : ""}
              </p>
            </li>
          ))}
        </ul>
        {query.data.unsupported.length > 0 ? (
          <ul
            aria-label={m(msg("Providers not supported yet"))}
            className="flex flex-col gap-1 text-xs text-muted-foreground"
          >
            {query.data.unsupported.map((item) => (
              <li key={item.provider}>
                {item.label} · {item.reason}
              </li>
            ))}
          </ul>
        ) : null}
        <div>
          <Button size="sm" variant="outline" onClick={query.refresh} disabled={query.isPending}>
            {m(msg("Refresh sources"))}
          </Button>
        </div>
      </section>
      {source ? (
        <HistorySearch
          key={JSON.stringify([source.id, source.capabilities])}
          {...props}
          sourceId={source.id}
          capabilities={source.capabilities}
        />
      ) : null}
    </div>
  );
}

function HistorySearch(props: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: string;
  readonly capabilities: ExternalHistorySource["capabilities"];
  readonly currentProjectPath?: string;
}) {
  const m = useMessages();
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
            ...externalHistorySearchFilters(props.capabilities, { filterCwd, includeArchived }),
          });
        }}
      >
        <Input
          aria-label={m(msg("Search external history"))}
          placeholder={m(msg("Find text in messages and tool evidence"))}
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={256}
        />
        {props.capabilities.cwdFilter ? (
          <>
            <Input
              aria-label={m(msg("History directory filter"))}
              placeholder={m(msg("All project directories"))}
              value={filterCwd}
              onChange={(event) => {
                setFilterCwd(event.target.value);
                setSearch(null);
              }}
              maxLength={4096}
            />
            {props.currentProjectPath ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFilterCwd(props.currentProjectPath!);
                    setSearch(null);
                  }}
                >
                  {m(msg("This project"))}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFilterCwd("");
                    setSearch(null);
                  }}
                >
                  {m(msg("All projects"))}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
        {props.capabilities.archived ? (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{m(msg("Include archived threads"))}</span>
            <Switch
              aria-label={m(msg("Include archived threads"))}
              checked={includeArchived}
              onCheckedChange={(value) => {
                setIncludeArchived(value);
                setSearch(null);
              }}
            />
          </div>
        ) : null}
        <div>
          <Button type="submit" size="sm" disabled={!text.trim()}>
            {m(msg("Search"))}
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
          {m(msg("Search messages and tool evidence from the selected source."))}
        </p>
      )}
    </div>
  );
}

function HistoryResults(props: { readonly environmentId: EnvironmentId; readonly search: Search }) {
  const m = useMessages();
  const [paging, dispatch] = useReducer(
    externalHistoryPagingReducer,
    undefined,
    initialExternalHistoryPaging,
  );
  const [selected, setSelected] = useState<ExternalHistoryMatch | null>(null);
  const cursor = paging.cursor;
  const query = useEnvironmentQuery(
    paging.status === "searching"
      ? externalHistory.query({
          environmentId: props.environmentId,
          input: { ...props.search, ...(cursor === undefined ? {} : { cursor }) },
        })
      : null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The query hook has no result callback to advance the shared pager.
  useEffect(() => {
    if (query.isSuccess && !query.isPending && query.data?.operation === "search")
      dispatch({ type: "page", cursor, page: query.data });
  }, [cursor, query.data, query.isPending, query.isSuccess]);
  const data = paging.status === "ready" ? paging.page : null;
  if (selected)
    return (
      <div className="flex flex-col gap-3">
        <div>
          <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
            {m(msg("Back to matches"))}
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
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">
        {m(msg("Searched {count, plural, one {# item} other {# items}}{ending}"), {
          count: paging.examinedItems,
          ending: paging.status === "searching" ? "…" : ".",
        })}
      </p>
      {paging.status === "searching" ? (
        <div>
          <Button size="sm" variant="outline" onClick={() => dispatch({ type: "stop" })}>
            {m(msg("Stop search"))}
          </Button>
        </div>
      ) : paging.status === "stopped" ? (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">{m(msg("Search stopped."))}</span>
          <Button size="sm" variant="outline" onClick={() => dispatch({ type: "resume" })}>
            {m(msg("Resume search"))}
          </Button>
        </div>
      ) : null}
      {data?.matches.length === 0 ? (
        <p className="text-sm">{m(msg("No more matches found."))}</p>
      ) : null}
      {data?.matches.map((match) => (
        <article
          key={match.ref.readCursor + ":" + match.ref.digest}
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <h3 className="text-sm font-medium">{match.threadTitle}</h3>
          <p className="text-muted-foreground text-xs">
            {m(msg("{role} · {count, plural, one {# character} other {# characters}}"), {
              role: externalHistoryRoleLabel(match.role, m),
              count: match.totalChars,
            })}
          </p>
          <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">
            {match.excerpt}
          </p>
          <div>
            <Button size="sm" variant="outline" onClick={() => setSelected(match)}>
              {m(msg("Open source"))}
            </Button>
          </div>
        </article>
      ))}
      {paging.previous.length > 0 || data?.nextCursor != null ? (
        <div className="flex justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={paging.previous.length === 0}
            onClick={() => dispatch({ type: "previous" })}
          >
            {m(msg("Previous page"))}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={data?.nextCursor == null}
            onClick={() => dispatch({ type: "next" })}
          >
            {m(msg("Continue search"))}
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
  const m = useMessages();
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
    return <p className="text-muted-foreground text-sm">{m(msg("Reading source…"))}</p>;
  const data = query.data;
  return (
    <article className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{data.threadTitle}</h3>
      <p className="text-muted-foreground text-xs">
        {externalHistoryRoleLabel(data.role, m)} · {externalHistoryRangeLabel(data, m)}
      </p>
      <p className="break-all text-muted-foreground text-xs">
        {m(msg("Thread {threadId} · Item {itemId}"), {
          threadId: data.ref.threadId,
          itemId: props.match.itemId,
        })}
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
            {m(msg("Previous source text"))}
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
            {m(msg("More source text"))}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
