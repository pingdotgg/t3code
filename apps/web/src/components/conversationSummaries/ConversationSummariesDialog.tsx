import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  conversationSummarySourceKey,
  type ConversationSummary,
  type ConversationSummaryExpansion,
  type ConversationSummaryId,
  type ConversationSummaryRead,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  conversationSummaryPassLabel,
  conversationSummarySourceRangeLabel,
  type ConversationSummarySourceCursor,
} from "@t3tools/client-runtime/conversationSummaries";
import { KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL } from "@t3tools/client-runtime/projectKnowledge";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { conversationSummaries } from "../../state/conversationSummaries";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
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
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { ExternalHistoryButton } from "../externalHistory/ExternalHistoryDialog";

const PAGE_SIZE = 20;
const SOURCE_PAGE_SIZE = 6;
const SOURCE_PAGE_CHARS = 12_000;

interface Scope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

/** The project opt-in. Summaries cost model calls, so it starts off. */
function SummariesToggle(props: Scope) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = config?.settings;
  if (!settings || config.environment.capabilities.projectSettingsOverrides !== true) return null;
  const enabled = resolveProjectSettings(settings, props.projectId).settings
    .enableConversationSummaries;
  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [props.projectId]: {
              ...settings.projectSettingsOverrides[props.projectId],
              enableConversationSummaries: next,
            },
          },
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <section
      aria-label="Summarize older messages"
      className="flex flex-col gap-1 rounded-md border p-3"
    >
      <div className="flex items-center justify-between gap-3 font-medium text-sm">
        <span>Summarize older messages</span>
        <Switch
          aria-label="Summarize older messages"
          checked={enabled}
          disabled={!canWrite || busy}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        After turns complete in this project, your text generation model summarizes settled
        stretches of older messages and tool output. Each summary costs one model call.
      </p>
      {!canWrite ? (
        <p className="text-xs">This connection cannot change project settings.</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function SummarySourcePage(props: {
  readonly data: ConversationSummaryExpansion;
  readonly cursor: ConversationSummarySourceCursor;
  readonly hasPrevious: boolean;
  readonly onPrevious: () => void;
  readonly onNext: (cursor: ConversationSummarySourceCursor) => void;
}) {
  const { sources, nextOffset, nextTextOffset } = props.data;
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {sources.map(({ ref, result }, index) => (
          <li key={conversationSummarySourceKey(ref)} className="rounded-md border p-2 text-sm">
            <p className="text-muted-foreground text-xs">
              #{props.cursor.offset + index + 1} ·{" "}
              {result.state === "available"
                ? result.role === "user"
                  ? "User"
                  : result.role === "tool"
                    ? "Tool"
                    : "Assistant"
                : "Unavailable"}
            </p>
            {conversationSummarySourceRangeLabel(ref, result) ? (
              <p className="text-muted-foreground text-xs">
                {conversationSummarySourceRangeLabel(ref, result)}
              </p>
            ) : null}
            {result.state === "available" ? (
              <p className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap">{result.text}</p>
            ) : (
              <p className="mt-1 text-muted-foreground">
                {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[result.reason]}.
              </p>
            )}
          </li>
        ))}
      </ol>
      {props.hasPrevious || nextOffset !== null ? (
        <div className="flex justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!props.hasPrevious}
            onClick={props.onPrevious}
          >
            Previous sources
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={nextOffset === null}
            onClick={() => {
              if (nextOffset !== null)
                props.onNext({ offset: nextOffset, textOffset: nextTextOffset ?? 0 });
            }}
          >
            Next sources
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SummaryStatements(props: { readonly summary: ConversationSummary }) {
  const position = new Map(
    props.summary.sources.map((source, index) => [conversationSummarySourceKey(source), index + 1]),
  );
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {props.summary.statements.map((statement) => (
        <li key={statement.text}>
          {statement.text}{" "}
          <span className="text-muted-foreground text-xs">
            [{statement.citations.map((id) => `#${position.get(id)}`).join(", ")}]
          </span>
        </li>
      ))}
    </ul>
  );
}

function SummaryCard(props: Scope & { readonly read: ConversationSummaryRead }) {
  const [showSources, setShowSources] = useState(false);
  const [sourceCursors, setSourceCursors] =
    useState<ReadonlyArray<ConversationSummarySourceCursor> | null>(null);
  const id = props.read.state === "available" ? props.read.summary.id : props.read.id;
  const cursor = sourceCursors?.at(-1) ?? { offset: 0, textOffset: 0 };
  const expansion = useEnvironmentQuery(
    sourceCursors === null
      ? null
      : conversationSummaries.expand({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            threadId: props.threadId,
            summaryId: id,
            ...cursor,
            limit: SOURCE_PAGE_SIZE,
            maxChars: SOURCE_PAGE_CHARS,
          },
        }),
  );
  const read = sourceCursors === null ? props.read : (expansion.data?.summary ?? null);
  const headerRead = read ?? props.read;
  const sourceCount =
    headerRead.state === "available" ? headerRead.summary.sources.length : headerRead.sourceCount;
  const createdAt =
    headerRead.state === "available" ? headerRead.summary.createdAt : headerRead.createdAt;
  return (
    <article className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-muted-foreground text-xs">
        {sourceCount} sources · written {new Date(createdAt).toLocaleString()}
      </p>
      {read === null ? (
        <p className="text-muted-foreground text-sm">
          {expansion.error
            ? "Summary unavailable until its sources can be checked."
            : "Checking sources…"}
        </p>
      ) : read.state === "available" ? (
        <SummaryStatements summary={read.summary} />
      ) : (
        <p className="text-sm">
          Outdated: {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[read.reason].toLowerCase()}. The summary
          text is hidden and agents no longer receive it.
        </p>
      )}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSourceCursors((current) => current ?? []);
            setShowSources((value) => !value);
          }}
        >
          {showSources ? "Hide sources" : "Show sources"}
        </Button>
      </div>
      {showSources ? (
        expansion.error ? (
          <p role="alert" className="text-destructive text-sm">
            {expansion.error}
          </p>
        ) : expansion.data === null ? (
          <p className="text-muted-foreground text-sm">Loading sources…</p>
        ) : (
          <SummarySourcePage
            data={expansion.data}
            cursor={cursor}
            hasPrevious={(sourceCursors?.length ?? 0) > 0}
            onPrevious={() => setSourceCursors((current) => current?.slice(0, -1) ?? [])}
            onNext={(nextCursor) => setSourceCursors((current) => [...(current ?? []), nextCursor])}
          />
        )
      ) : null}
    </article>
  );
}

function SummaryList(props: Scope & { readonly searchSupported: boolean }) {
  const [cursors, setCursors] = useState<ReadonlyArray<ConversationSummaryId>>([]);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  return (
    <div className="flex flex-col gap-3">
      {props.searchSupported ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(searchText.trim());
            setCursors([]);
          }}
        >
          <Input
            aria-label="Search summaries"
            placeholder="Search summary text"
            maxLength={256}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
          {searchText || query ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchText("");
                setQuery("");
                setCursors([]);
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
      ) : (
        <p className="text-muted-foreground text-xs">Update this server to search summaries.</p>
      )}
      <SummaryListPage
        key={JSON.stringify([query, cursors.at(-1)])}
        {...props}
        query={query}
        cursors={cursors}
        onEarlier={() => setCursors((current) => current.slice(0, -1))}
        onLater={(cursor) => setCursors((current) => [...current, cursor])}
      />
    </div>
  );
}

function SummaryListPage(
  props: Scope & {
    readonly query: string;
    readonly cursors: ReadonlyArray<ConversationSummaryId>;
    readonly onEarlier: () => void;
    readonly onLater: (cursor: ConversationSummaryId) => void;
  },
) {
  const cursor = props.cursors.at(-1);
  const list = useEnvironmentQuery(
    conversationSummaries.list({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
        ...(props.query ? { query: props.query } : {}),
      },
    }),
  );
  if (list.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {list.error}
      </p>
    );
  if (!list.data) return <p className="text-muted-foreground text-sm">Loading summaries…</p>;
  const { lastPass, summaries, nextCursor, enabled } = list.data;
  return (
    <div className="flex flex-col gap-3">
      {lastPass ? (
        <p className="text-muted-foreground text-xs">{conversationSummaryPassLabel(lastPass)}</p>
      ) : enabled ? (
        <p className="text-muted-foreground text-xs">
          The first summary is written after a turn completes and enough older messages have
          settled.
        </p>
      ) : null}
      {summaries.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {props.query ? "No summaries match your search." : "This thread has no summaries yet."}
        </p>
      ) : (
        summaries.map((read) => (
          <SummaryCard
            key={read.state === "available" ? read.summary.id : read.id}
            {...props}
            read={read}
          />
        ))
      )}
      {props.cursors.length > 0 || nextCursor !== null ? (
        <div className="flex justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={props.cursors.length === 0}
            onClick={props.onEarlier}
          >
            Earlier
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={nextCursor === null}
            onClick={() => {
              if (nextCursor !== null) props.onLater(nextCursor);
            }}
          >
            Later
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ConversationSummariesDialog(
  props: Scope & { readonly open: boolean; readonly onOpenChange: (open: boolean) => void },
) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const project = useProject({ environmentId: props.environmentId, projectId: props.projectId });
  const searchSupported = config?.environment.capabilities.conversationSummarySourceFormat === 2;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Conversation summaries</DialogTitle>
          <DialogDescription>
            Model-written summaries of this thread's older messages and tool output. When the thread
            moves to another provider or is forked, agents receive them in place of messages that no
            longer fit, and can open the exact sources behind each one.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <SummariesToggle {...props} />
            <div>
              <ExternalHistoryButton
                environmentId={props.environmentId}
                {...(project ? { currentProjectPath: project.workspaceRoot } : {})}
              />
            </div>
            {props.open ? (
              <SummaryList
                key={`${props.environmentId}:${props.projectId}:${props.threadId}:${searchSupported}`}
                {...props}
                searchSupported={searchSupported}
              />
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
