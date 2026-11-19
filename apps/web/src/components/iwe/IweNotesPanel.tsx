import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { IweCompletion, IweNote, IweToolStatus, ScopedThreadRef } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  DownloadIcon,
  LinkIcon,
  NotebookPenIcon,
  PaperclipIcon,
  PencilIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useDeferredValue, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { iweEnvironment } from "../../state/iwe";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  applyCompletion,
  backlinksOf,
  outgoingLinksOf,
  positionAt,
  resolveNoteLink,
  wantsLinkCompletion,
  wikiLinksToMarkdown,
} from "./IweNotesPanel.logic";

const REMARK_PLUGINS = [remarkGfm];
/** Note typography; scoped here because the app has no shared prose styles. */
const PREVIEW_CLASS =
  "text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-2 [&_h1]:font-semibold [&_h1]:text-lg [&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:font-semibold [&_h2]:text-base [&_h3]:mt-3 [&_h3]:font-medium [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:ps-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:ps-5";

function failureText(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() ? error.message : "IWE did not respond.";
}

/** IWE notes beside the thread: search, read with links and backlinks, edit with IWE's own tools. */
export function IweNotesPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const environmentId = threadRef.environmentId;
  const statusQuery = useEnvironmentQuery(iweEnvironment.status({ environmentId, input: {} }));
  const threadQuery = useEnvironmentQuery(
    iweEnvironment.threadState({ environmentId, input: { threadId: threadRef.threadId } }),
  );
  const status = statusQuery.data;
  const root = threadQuery.data?.workspaceRoot ?? null;

  if (status && (status.cli === null || status.languageServer === null)) {
    return (
      <IweSetup
        environmentId={environmentId}
        status={status}
        onDone={() => statusQuery.refresh()}
      />
    );
  }
  if (threadQuery.data && root === null) {
    return <IweChooseWorkspace threadRef={threadRef} onChosen={() => threadQuery.refresh()} />;
  }
  if (root === null) {
    return <div className="p-4 text-muted-foreground text-sm">Loading IWE…</div>;
  }
  return (
    <IweWorkspaceView
      threadRef={threadRef}
      root={root}
      threadState={threadQuery.data}
      onThreadChanged={() => threadQuery.refresh()}
    />
  );
}

function IweSetup({
  environmentId,
  status,
  onDone,
}: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly status: IweToolStatus;
  readonly onDone: () => void;
}) {
  const install = useAtomCommand(iweEnvironment.install, { reportFailure: false });
  const canInstall = useAtomValue(iweEnvironment.install.permissionAtom(environmentId));
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const missing = [
    status.cli === null ? "iwe (the CLI)" : null,
    status.languageServer === null ? "iwes (the language server)" : null,
  ].filter(Boolean);
  const onInstall = async () => {
    setError(null);
    setProgress("Downloading IWE…");
    const result = await install({
      environmentId,
      input: {
        input: {},
        onEvent: (event) => {
          if (event.type === "progress" && event.totalBytes)
            setProgress(
              `Downloading IWE… ${Math.round(((event.completedBytes ?? 0) / event.totalBytes) * 100)}%`,
            );
        },
      },
    });
    setProgress(null);
    if (result._tag !== "Success") setError(failureText(result));
    onDone();
  };
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <NotebookPenIcon className="size-4" /> Set up IWE
      </div>
      <p className="text-muted-foreground">
        Continuum uses IWE's own tools for notes. Missing: {missing.join(" and ")}.
      </p>
      {status.setup.map((step) => (
        <div key={step.title} className="rounded-md border border-border p-3">
          <div className="mb-1 font-medium">{step.title}</div>
          {step.commands.map((command) => (
            <pre
              key={command}
              className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs"
            >
              {command}
            </pre>
          ))}
          {step.note ? <p className="mt-1 text-muted-foreground text-xs">{step.note}</p> : null}
        </div>
      ))}
      {status.managedInstall ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!canInstall || progress !== null}
            onClick={() => void onInstall()}
            size="sm"
          >
            <DownloadIcon />
            {progress ?? "Install IWE for Continuum"}
          </Button>
          <span className="text-muted-foreground text-xs">
            From {status.managedInstall.source}, into Continuum's tools folder.
          </span>
        </div>
      ) : null}
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button onClick={onDone} size="sm" variant="ghost">
        <RefreshCwIcon /> Check again
      </Button>
    </div>
  );
}

function IweChooseWorkspace({
  threadRef,
  onChosen,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onChosen: () => void;
}) {
  const select = useAtomCommand(iweEnvironment.selectWorkspace, { reportFailure: false });
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const choose = async () => {
    const result = await select({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, root: path.trim() },
    });
    if (result._tag !== "Success") return setError(failureText(result));
    onChosen();
  };
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <NotebookPenIcon className="size-4" /> IWE notes
      </div>
      <p className="text-muted-foreground">
        This thread's project is not an IWE workspace. Open one with Add project → Open IWE
        Workspace, or use a workspace's notes in this thread:
      </p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void choose();
        }}
      >
        <Input
          aria-label="IWE workspace folder"
          onChange={(event) => setPath(event.currentTarget.value)}
          placeholder="/path/to/notes"
          value={path}
        />
        <Button disabled={path.trim() === ""} size="sm" type="submit">
          Use
        </Button>
      </form>
      {error ? <p className="text-destructive-foreground text-xs">{error}</p> : null}
    </div>
  );
}

function IweWorkspaceView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly root: string;
  readonly threadState: {
    readonly attachments: ReadonlyArray<{ key: string; title: string; depth: number }>;
    readonly activity: ReadonlyArray<{
      key: string;
      title: string;
      action: string;
      by: string;
      at: string;
    }>;
  } | null;
  readonly onThreadChanged: () => void;
}) {
  const { threadRef, root } = props;
  const environmentId = threadRef.environmentId;
  const loadNote = useAtomCommand(iweEnvironment.note, { reportFailure: false });
  const attach = useAtomCommand(iweEnvironment.attach, { reportFailure: false });
  const detach = useAtomCommand(iweEnvironment.detach, { reportFailure: false });
  const workspaceQuery = useEnvironmentQuery(
    iweEnvironment.workspace({ environmentId, input: { root } }),
  );
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"both" | "fuzzy" | "lexical">("both");
  const [history, setHistory] = useState<ReadonlyArray<string>>([]);
  const [note, setNote] = useState<IweNote | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachDepth, setAttachDepth] = useState(1);
  const deferredQuery = useDeferredValue(query);
  const searchQuery = useEnvironmentQuery(
    iweEnvironment.searchResults({
      environmentId,
      input: { root, query: deferredQuery, mode, limit: 40 },
    }),
  );
  const results = searchQuery.data;

  const open = async (key: string, push = true) => {
    setError(null);
    const result = await loadNote({ environmentId, input: { root, key } });
    if (result._tag !== "Success") return setError(failureText(result));
    if (push && note) setHistory((current) => [...current, note.key]);
    setEditing(false);
    setNote(result.value);
  };
  const back = () => {
    const previous = history.at(-1);
    setHistory((current) => current.slice(0, -1));
    if (previous) void open(previous, false);
    else setNote(null);
  };

  const onPreviewClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor || !note) return;
    const target = resolveNoteLink(note.key, anchor.getAttribute("href") ?? "");
    if (target === null) return;
    event.preventDefault();
    void open(target);
  };

  const onAttach = async () => {
    if (!note) return;
    const result = await attach({
      environmentId,
      input: { threadId: threadRef.threadId, root, key: note.key, depth: attachDepth },
    });
    if (result._tag !== "Success") setError(failureText(result));
    props.onThreadChanged();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm" data-testid="iwe-notes-panel">
      <div className="flex items-center gap-2 border-border border-b px-3 py-2">
        <NotebookPenIcon className="size-4 shrink-0" />
        <span className="min-w-0 truncate font-medium">{workspaceQuery.data?.name ?? root}</span>
        {workspaceQuery.data ? (
          <Badge variant="secondary">{workspaceQuery.data.documentCount} notes</Badge>
        ) : null}
      </div>
      {props.threadState && props.threadState.attachments.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 border-border border-b px-3 py-2 text-xs">
          <PaperclipIcon className="size-3.5" />
          <span className="text-muted-foreground">Goes with your next message:</span>
          {props.threadState.attachments.map((attachment) => (
            <Badge key={attachment.key} variant="info">
              {attachment.title}
              {attachment.depth > 0 ? ` + links (${attachment.depth})` : ""}
              <button
                aria-label={`Remove ${attachment.title}`}
                className="ms-1"
                onClick={() =>
                  void detach({
                    environmentId,
                    input: { threadId: threadRef.threadId, key: attachment.key },
                  }).then(() => props.onThreadChanged())
                }
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      {(error ?? searchQuery.error) ? (
        <Alert className="m-3" variant="error">
          <AlertDescription>{error ?? searchQuery.error}</AlertDescription>
        </Alert>
      ) : null}
      {note === null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 px-3 py-2">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <Input
              aria-label="Search notes"
              autoFocus
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search notes"
              value={query}
            />
            <select
              aria-label="Search mode"
              className="rounded-md border border-border bg-background px-1 py-1 text-xs"
              onChange={(event) => setMode(event.currentTarget.value as typeof mode)}
              value={mode}
            >
              <option value="both">Titles + text</option>
              <option value="fuzzy">Titles</option>
              <option value="lexical">Full text</option>
            </select>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-1" aria-label="Notes">
            {(results ?? []).map((result) => (
              <li key={result.key}>
                <button
                  className="flex w-full flex-col rounded-md px-2 py-1.5 text-start hover:bg-accent"
                  onClick={() => void open(result.key)}
                  type="button"
                >
                  <span className="truncate font-medium">{result.title}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {result.key} · {outgoingLinksOf(result).length} links ·{" "}
                    {backlinksOf(result).length} backlinks
                  </span>
                </button>
              </li>
            ))}
            {results !== null && results.length === 0 ? (
              <li className="px-2 py-4 text-muted-foreground">No notes match.</li>
            ) : null}
          </ul>
          <IweActivity
            activity={props.threadState?.activity ?? []}
            onOpen={(key) => void open(key)}
          />
        </div>
      ) : editing ? (
        <IweEditor
          environmentId={environmentId}
          note={note}
          onCancel={() => setEditing(false)}
          onRenamed={(key) => {
            setNote(null);
            setEditing(false);
            searchQuery.refresh();
            void open(key, false);
          }}
          onSaved={(saved) => {
            setNote(saved);
            setEditing(false);
            props.onThreadChanged();
          }}
          root={root}
          threadId={threadRef.threadId}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-1 border-border border-b px-2 py-1.5">
            <Button aria-label="Back" onClick={back} size="icon-xs" variant="ghost">
              <ArrowLeftIcon />
            </Button>
            <span className="min-w-0 flex-1 truncate font-medium">{note.title}</span>
            <Button onClick={() => setEditing(true)} size="xs" variant="ghost">
              <PencilIcon /> Edit
            </Button>
            <select
              aria-label="Linked context"
              className="rounded-md border border-border bg-background px-1 py-0.5 text-xs"
              onChange={(event) => setAttachDepth(Number(event.currentTarget.value))}
              value={attachDepth}
            >
              <option value={0}>Note only</option>
              <option value={1}>+ linked notes</option>
              <option value={2}>+ 2 hops</option>
            </select>
            <Button onClick={() => void onAttach()} size="xs" variant="outline">
              <PaperclipIcon /> Attach to session
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <div className={PREVIEW_CLASS} data-testid="iwe-note-preview" onClick={onPreviewClick}>
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>
                {wikiLinksToMarkdown(note.content)}
              </ReactMarkdown>
            </div>
            <IweLinkList
              onOpen={(key) => void open(key)}
              links={outgoingLinksOf(note)}
              title="Links"
            />
            <IweLinkList
              onOpen={(key) => void open(key)}
              links={backlinksOf(note)}
              title="Backlinks"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function IweLinkList({
  title,
  links,
  onOpen,
}: {
  readonly title: string;
  readonly links: ReadonlyArray<{ key: string; title: string }>;
  readonly onOpen: (key: string) => void;
}) {
  return (
    <section aria-label={title} className="mt-4 border-border border-t pt-2">
      <h4 className="mb-1 font-medium text-muted-foreground text-xs uppercase">{title}</h4>
      {links.length === 0 ? <p className="text-muted-foreground text-xs">None</p> : null}
      <ul>
        {links.map((link) => (
          <li key={link.key}>
            <button
              className="flex items-center gap-1 rounded px-1 py-0.5 text-start hover:bg-accent"
              onClick={() => onOpen(link.key)}
              type="button"
            >
              <LinkIcon className="size-3" />
              {link.title}
              <span className="text-muted-foreground text-xs">{link.key}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IweActivity({
  activity,
  onOpen,
}: {
  readonly activity: ReadonlyArray<{
    key: string;
    title: string;
    action: string;
    by: string;
    at: string;
  }>;
  readonly onOpen: (key: string) => void;
}) {
  if (activity.length === 0) return null;
  return (
    <section
      aria-label="Notes used in this thread"
      className="max-h-48 overflow-y-auto border-border border-t px-3 py-2"
    >
      <h4 className="mb-1 font-medium text-muted-foreground text-xs uppercase">
        Used in this thread
      </h4>
      <ul className="flex flex-col gap-0.5">
        {activity.slice(0, 20).map((entry) => (
          <li
            key={`${entry.key}-${entry.at}-${entry.action}`}
            className="flex items-center gap-2 text-xs"
          >
            <Badge
              variant={
                entry.action === "updated" ||
                entry.action === "created" ||
                entry.action === "renamed"
                  ? "warning"
                  : "secondary"
              }
            >
              {entry.by === "agent" ? "Agent" : "You"} {entry.action}
            </Badge>
            <button
              className="truncate hover:underline"
              onClick={() => onOpen(entry.key)}
              type="button"
            >
              {entry.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IweEditor(props: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly root: string;
  readonly note: IweNote;
  readonly threadId: ScopedThreadRef["threadId"];
  readonly onSaved: (note: IweNote) => void;
  readonly onRenamed: (key: string) => void;
  readonly onCancel: () => void;
}) {
  const save = useAtomCommand(iweEnvironment.saveNote, { reportFailure: false });
  const complete = useAtomCommand(iweEnvironment.complete, { reportFailure: false });
  const renameLink = useAtomCommand(iweEnvironment.renameLink, { reportFailure: false });
  const [text, setText] = useState(props.note.content);
  const [completions, setCompletions] = useState<ReadonlyArray<IweCompletion>>([]);
  const [active, setActive] = useState(0);
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const requestId = useRef(0);

  const requestCompletions = async (value: string, offset: number) => {
    const id = ++requestId.current;
    if (!wantsLinkCompletion(value, offset)) return setCompletions([]);
    const position = positionAt(value, offset);
    const result = await complete({
      environmentId: props.environmentId,
      input: { root: props.root, key: props.note.key, text: value, ...position },
    });
    if (id !== requestId.current) return;
    setActive(0);
    setCompletions(result._tag === "Success" ? result.value.slice(0, 12) : []);
  };

  const accept = (item: IweCompletion) => {
    const offset = area.current?.selectionStart ?? text.length;
    const next = applyCompletion(text, offset, item.replaceFrom, item.replaceTo, item.insertText);
    setText(next.text);
    setCompletions([]);
    requestAnimationFrame(() => area.current?.setSelectionRange(next.cursor, next.cursor));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (completions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive(
          (current) =>
            (current + (event.key === "ArrowDown" ? 1 : completions.length - 1)) %
            completions.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        accept(completions[active]!);
        return;
      }
      if (event.key === "Escape") return setCompletions([]);
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      void onSave();
    }
  };

  const onSave = async () => {
    const result = await save({
      environmentId: props.environmentId,
      input: { root: props.root, key: props.note.key, content: text, threadId: props.threadId },
    });
    if (result._tag !== "Success") return setMessage(failureText(result));
    props.onSaved(result.value);
  };

  const onRename = async () => {
    if (renameTo === null || renameTo.trim() === "" || text !== props.note.content) return;
    const offset = area.current?.selectionStart ?? 0;
    const result = await renameLink({
      environmentId: props.environmentId,
      input: {
        root: props.root,
        key: props.note.key,
        text,
        ...positionAt(text, offset),
        newName: renameTo.trim(),
      },
    });
    setRenameTo(null);
    if (result._tag !== "Success") return setMessage(failureText(result));
    props.onRenamed(result.value.key);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-border border-b px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-medium">{props.note.title}</span>
        {renameTo === null ? (
          <Button
            disabled={text !== props.note.content}
            onClick={() => setRenameTo("")}
            size="xs"
            variant="ghost"
          >
            Rename link target
          </Button>
        ) : (
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void onRename();
            }}
          >
            <Input
              aria-label="New name for the linked note"
              autoFocus
              onChange={(event) => setRenameTo(event.currentTarget.value)}
              placeholder="new-key (relative to this note)"
              size="sm"
              value={renameTo}
            />
            <Button disabled={text !== props.note.content} size="xs" type="submit">
              Rename
            </Button>
          </form>
        )}
        <Button onClick={props.onCancel} size="xs" variant="ghost">
          Cancel
        </Button>
        <Button onClick={() => void onSave()} size="xs">
          <SaveIcon /> Save
        </Button>
      </div>
      {message ? <p className="px-3 py-1 text-muted-foreground text-xs">{message}</p> : null}
      <div className="relative min-h-0 flex-1">
        <textarea
          aria-label="Note Markdown"
          className="h-full min-h-full w-full resize-none bg-background p-3 font-mono text-xs outline-none"
          onChange={(event) => {
            setText(event.currentTarget.value);
            void requestCompletions(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onKeyDown={onKeyDown}
          ref={area}
          value={text}
        />
        {completions.length > 0 ? (
          <ul
            aria-label="Link suggestions"
            className="absolute inset-x-3 bottom-3 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
            role="listbox"
          >
            {completions.map((item, index) => (
              <li
                aria-selected={index === active}
                key={`${item.label}-${item.insertText}`}
                role="option"
              >
                <button
                  className={`flex w-full justify-between gap-2 rounded px-2 py-1 text-start text-xs ${index === active ? "bg-accent" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    accept(item);
                  }}
                  type="button"
                >
                  <span className="truncate">{item.label}</span>
                  <span className="truncate font-mono text-muted-foreground">
                    {item.insertText}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
