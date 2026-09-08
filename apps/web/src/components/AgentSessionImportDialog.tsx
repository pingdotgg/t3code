import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  type AgentSessionListResult,
  type AgentSessionPreviewResult,
  type AgentSessionSummary,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { agentSessionAttach, agentSessionList, agentSessionPreview } from "../state/agentSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { buildThreadRouteParams } from "../threadRoutes";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Input } from "./ui/input";

type RequestState = "idle" | "loading" | { error: string };
type Scope = { projectRef: ScopedProjectRef; cwd: string; machineName: string };

export function AgentSessionImportDialog(props: Scope) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="pt-4 text-center">
        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => setOpen(true)}
        >
          or, import an existing session
        </button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup
          className="flex h-[min(80vh,800px)] w-[min(1100px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden"
          bottomStickOnMobile={false}
        >
          <DialogHeader className="shrink-0 border-b">
            <DialogTitle>Import an existing session</DialogTitle>
            <DialogDescription>{props.machineName} · Claude Code</DialogDescription>
            <p className="break-all font-mono text-xs text-muted-foreground">{props.cwd}</p>
          </DialogHeader>
          {open ? <SessionBrowser {...props} onClose={() => setOpen(false)} /> : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

const sessionKey = (session: AgentSessionSummary) =>
  `${session.providerInstanceId}:${session.providerSessionId}`;

function SessionBrowser({ projectRef, cwd, onClose }: Scope & { onClose: () => void }) {
  const readList = useAtomQueryRunner(agentSessionList, { reportFailure: false, refresh: true });
  const [result, setResult] = useState<AgentSessionListResult>({
    sessions: [],
    nextCursor: null,
    truncated: false,
  });
  const [request, setRequest] = useState<RequestState>("loading");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = result.sessions.find((session) => sessionKey(session) === selectedId) ?? null;
  const generation = useRef(0);

  const load = useCallback(
    async (cursor?: string) => {
      const current = ++generation.current;
      const response = await readList({
        environmentId: projectRef.environmentId,
        input: {
          projectId: projectRef.projectId,
          expectedWorkspaceRoot: cwd,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      if (current !== generation.current) return;
      if (response._tag === "Failure") {
        setRequest({ error: String(squashAtomCommandFailure(response)) });
        return;
      }
      setResult((previous) => ({
        ...response.value,
        sessions:
          cursor === undefined
            ? response.value.sessions
            : [...previous.sessions, ...response.value.sessions],
      }));
      setRequest("idle");
    },
    [cwd, projectRef.environmentId, projectRef.projectId, readList],
  );
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const query = search.trim().toLowerCase();
  const sessions = result.sessions.filter((session) =>
    `${session.title}\n${session.firstRequest}`.toLowerCase().includes(query),
  );
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(100px,30%)_minmax(0,1fr)] sm:grid-cols-[minmax(200px,32%)_minmax(0,1fr)] sm:grid-rows-1">
      <div className="flex min-h-0 flex-col border-b sm:border-r sm:border-b-0">
        <div className="p-3">
          <Input
            aria-label="Search listed sessions"
            placeholder="Search listed sessions…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Claude Code sessions">
          {sessions.map((session) => (
            <button
              type="button"
              key={sessionKey(session)}
              aria-pressed={selectedId === sessionKey(session)}
              className={`mb-1 w-full rounded-md p-3 text-left hover:bg-accent ${selectedId === sessionKey(session) ? "bg-accent" : ""}`}
              onClick={() => setSelectedId(sessionKey(session))}
            >
              <div className="line-clamp-2 text-sm font-medium">{session.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {new Date(session.updatedAt).toLocaleString()}
              </div>
              {session.branch ? (
                <div className="truncate text-xs text-muted-foreground">{session.branch}</div>
              ) : null}
              {session.existingThreadId ? (
                <div className="mt-1 text-xs text-primary">Already loaded</div>
              ) : null}
            </button>
          ))}
          {request === "loading" ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              Loading sessions…
            </p>
          ) : null}
          {typeof request === "object" ? (
            <div role="alert" className="p-3 text-sm">
              <p>Could not load sessions. Check this machine's connection.</p>
              <p className="break-words text-xs text-muted-foreground">{request.error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRequest("loading");
                  void load();
                }}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {request === "idle" && sessions.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {query
                ? "No matching listed sessions."
                : "No Claude Code sessions found in this directory."}
            </p>
          ) : null}
          {result.truncated ? (
            <p className="p-3 text-xs text-muted-foreground">
              Some files could not be listed within the scan limits.
            </p>
          ) : null}
          {result.nextCursor !== null ? (
            <Button
              className="w-full"
              variant="ghost"
              size="sm"
              disabled={request === "loading"}
              onClick={() => {
                setRequest("loading");
                void load(result.nextCursor ?? undefined);
              }}
            >
              Load older sessions
            </Button>
          ) : null}
        </div>
      </div>
      {selected ? (
        <SessionPreview
          key={sessionKey(selected)}
          projectRef={projectRef}
          cwd={cwd}
          session={selected}
          onClose={onClose}
        />
      ) : (
        <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
          Select a session to read its conversation.
        </div>
      )}
    </div>
  );
}

function SessionPreview({
  projectRef,
  cwd,
  session,
  onClose,
}: Pick<Scope, "projectRef" | "cwd"> & { session: AgentSessionSummary; onClose: () => void }) {
  const readPreview = useAtomQueryRunner(agentSessionPreview, {
    reportFailure: false,
    refresh: true,
  });
  const attach = useAtomCommand(agentSessionAttach, { reportFailure: false });
  const navigate = useNavigate();
  const [preview, setPreview] = useState<AgentSessionPreviewResult>({
    messages: [],
    nextBefore: null,
    truncated: false,
  });
  const [request, setRequest] = useState<RequestState>("loading");
  const [attachment, setAttachment] = useState<RequestState>("idle");
  const generation = useRef(0);
  const mounted = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<
    "latest" | { height: number; top: number; messageId: string | null; offset: number } | null
  >(null);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const anchor = pendingScroll.current;
    if (!node || anchor === null || preview.messages.length === 0) return;
    if (anchor === "latest") {
      node.scrollTop = node.scrollHeight;
    } else {
      const message = node.querySelector<HTMLElement>(
        `[data-preview-message-id="${anchor.messageId}"]`,
      );
      node.scrollTop = message
        ? message.offsetTop - anchor.offset
        : node.scrollHeight - anchor.height + anchor.top;
    }
    pendingScroll.current = null;
  }, [preview.messages]);
  const scope = useMemo(
    () => ({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        expectedWorkspaceRoot: cwd,
        providerInstanceId: session.providerInstanceId,
        providerSessionId: session.providerSessionId,
      },
    }),
    [
      cwd,
      projectRef.environmentId,
      projectRef.projectId,
      session.providerInstanceId,
      session.providerSessionId,
    ],
  );
  const load = useCallback(
    async (before?: number) => {
      const current = ++generation.current;
      const node = scrollRef.current;
      const message = node
        ? Array.from(node.querySelectorAll<HTMLElement>("[data-preview-message-id]")).find(
            (entry) => entry.offsetTop + entry.offsetHeight > node.scrollTop,
          )
        : undefined;
      const anchor =
        before === undefined || !node
          ? "latest"
          : {
              height: node.scrollHeight,
              top: node.scrollTop,
              messageId: message?.getAttribute("data-preview-message-id") ?? null,
              offset: message ? message.offsetTop - node.scrollTop : 0,
            };
      const response = await readPreview({
        ...scope,
        input: { ...scope.input, ...(before === undefined ? {} : { before }) },
      });
      if (current !== generation.current) return;
      if (response._tag === "Failure") {
        setRequest({ error: String(squashAtomCommandFailure(response)) });
        return;
      }
      pendingScroll.current = anchor;
      setPreview((previous) => ({
        ...response.value,
        truncated: previous.truncated || response.value.truncated,
        messages:
          before === undefined
            ? response.value.messages
            : [...response.value.messages, ...previous.messages],
      }));
      setRequest("idle");
    },
    [readPreview, scope],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      generation.current += 1;
      mounted.current = false;
    };
  }, [load]);
  async function open() {
    setAttachment("loading");
    const response = await attach(scope);
    if (!mounted.current) return;
    if (response._tag === "Failure") {
      setAttachment({ error: String(squashAtomCommandFailure(response)) });
      return;
    }
    onClose();
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(projectRef.environmentId, response.value.threadId),
      ),
    });
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto p-5 [overflow-anchor:none]"
        aria-label="Session conversation"
      >
        {preview.nextBefore !== null ? (
          <Button
            variant="outline"
            size="sm"
            disabled={request === "loading"}
            onClick={() => {
              setRequest("loading");
              void load(preview.nextBefore ?? undefined);
            }}
          >
            Load earlier history
          </Button>
        ) : null}
        {request === "loading" ? (
          <p role="status" className="py-3 text-sm text-muted-foreground">
            Loading conversation…
          </p>
        ) : null}
        {typeof request === "object" ? (
          <div role="alert" className="py-3 text-sm">
            <p>Conversation preview unavailable.</p>
            <p className="text-muted-foreground">{request.error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRequest("loading");
                void load();
              }}
            >
              Retry preview
            </Button>
          </div>
        ) : null}
        {preview.truncated ? (
          <p className="py-3 text-xs text-muted-foreground">
            Some oversized or malformed transcript records are not shown.
          </p>
        ) : null}
        {request === "idle" && preview.messages.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            No readable user or assistant text in this part of the session. Try earlier history.
          </p>
        ) : null}
        {preview.messages.map((message) => (
          <article
            key={message.id}
            data-preview-message-id={message.id}
            className="border-b py-5 last:border-0"
          >
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {message.role === "user" ? "You" : "Claude"}
            </p>
            <ChatMarkdown
              text={message.text}
              cwd={cwd}
              environmentId={projectRef.environmentId}
              previewOnly
              lineBreaks={message.role === "user"}
            />
          </article>
        ))}
      </div>
      <div className="shrink-0 border-t p-4">
        <p className="mb-3 text-xs text-muted-foreground">
          T3 imports recent messages and continues the original session. Avoid sending from the
          original terminal at the same time. Newly attached sessions require approval.
        </p>
        {typeof attachment === "object" ? (
          <p role="alert" className="mb-2 text-sm text-destructive">
            {attachment.error}
          </p>
        ) : null}
        <Button className="w-full" disabled={attachment === "loading"} onClick={() => void open()}>
          {attachment === "loading"
            ? "Opening…"
            : session.existingThreadId
              ? "Open existing thread"
              : "Attach & open"}
        </Button>
      </div>
    </div>
  );
}
