import {
  GUEST_MESSAGE_MAX_LENGTH,
  GUEST_NAME_MAX_LENGTH,
  GUEST_ROUTE_PREFIX,
  GUEST_SHARE_PARAM,
  GuestMessageId,
  type GuestRedeemRequest,
  type GuestShareView,
  type GuestSubmitRequest,
  type GuestTranscriptItem,
  type ThreadGuestMessage,
  type ThreadGuestMessageStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ArrowUpIcon, CircleDashedIcon } from "lucide-react";
import { useEffect, useReducer, useState, type FormEvent, type KeyboardEvent } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { GuestMessageName, guestBubbleClassName } from "../chat/guestMessageStyle";
import { GuestHtmlRender } from "./GuestHtmlRender";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  applyGuestStreamEvent,
  formatGuestExpiry,
  groupGuestTranscript,
  initialGuestStreamState,
  inviteShareId,
  type GuestStreamState,
  parseGuestStreamEvent,
  unplacedGuestMessages,
} from "./guestStream.logic";

interface GuestEntry {
  /** Unspent invite from the URL hash, if this load came from a link. */
  readonly credential: string | null;
  readonly shareId: string | null;
}

let capturedEntry: GuestEntry | null = null;

// A reload keeps the tab's session, so it keeps which messages still wait for a row too.
const AWAITING_ROWS_KEY = "t3:guest-awaiting-rows";
const AWAITING_ROWS_LIMIT = 50;

function readAwaitingRowIds(): ReadonlySet<GuestMessageId> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(AWAITING_ROWS_KEY) ?? "[]");
    return new Set(
      Array.isArray(stored)
        ? stored.filter((id) => typeof id === "string").map((id) => GuestMessageId.make(id))
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeAwaitingRowIds(ids: ReadonlySet<GuestMessageId>) {
  try {
    sessionStorage.setItem(AWAITING_ROWS_KEY, JSON.stringify([...ids].slice(-AWAITING_ROWS_LIMIT)));
  } catch {}
}

/**
 * The invite credential travels in the URL hash so it never reaches a server log. It is read
 * once and removed from history, so it lives only in memory. Opening the page never redeems it:
 * only submitting a name does, so a reload before that leaves the link usable.
 */
function takeGuestEntry(): GuestEntry {
  if (capturedEntry === null) {
    // A malformed fragment is an invalid link, not a crash.
    let credential = "";
    try {
      credential = decodeURIComponent(window.location.hash.slice(1)).trim();
    } catch {}
    const shareId =
      credential !== ""
        ? inviteShareId(credential)
        : new URLSearchParams(window.location.search).get(GUEST_SHARE_PARAM);
    // The share stays in the URL, so a reload or bookmark finds this browser's session for it.
    window.history.replaceState(
      window.history.state,
      "",
      shareId === null
        ? window.location.pathname
        : `${window.location.pathname}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
    );
    capturedEntry = { credential: credential === "" ? null : credential, shareId };
  }
  return capturedEntry;
}

const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

/** Resolves to null on success, or to a message the guest can read. */
async function postGuest(
  path: "redeem" | "messages",
  body: typeof GuestRedeemRequest.Encoded | typeof GuestSubmitRequest.Encoded,
): Promise<string | null> {
  try {
    const response = await fetch(`${GUEST_ROUTE_PREFIX}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return null;
    const json: unknown = await response.json().catch(() => null);
    return Option.match(decodeErrorBody(json), {
      onNone: () => "Something went wrong. Try again.",
      onSome: ({ message }) => message,
    });
  } catch {
    return "Could not reach the server.";
  }
}

const STATUS_LABEL: Record<ThreadGuestMessageStatus, string> = {
  pending: "Waiting for approval",
  sent: "Sent",
  dismissed: "Not sent",
};

/** Same column as the owner's timeline, so both views wrap text at the same width. */
const LANE = "chat-content-lane px-4";

type GuestAccess = "checking" | "session" | "name" | "none";

export function GuestPage() {
  const [{ credential, shareId }] = useState(takeGuestEntry);
  // A browser that already joined this share goes straight back in, even from the spent link.
  // Sessions are per share, so one for another link never stands in for this one.
  const [access, setAccess] = useState<GuestAccess>(shareId === null ? "none" : "checking");
  useEffect(() => {
    if (shareId === null) return;
    let live = true;
    void fetch(`${GUEST_ROUTE_PREFIX}/session?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`)
      .then(
        (response): GuestAccess =>
          response.ok ? "session" : credential !== null ? "name" : "none",
        // Offline: an invite still needs the name form; without one, the stream reports what
        // it finds once the network is back.
        (): GuestAccess => (credential !== null ? "name" : "session"),
      )
      .then((next) => {
        if (live) setAccess(next);
      });
    return () => {
      live = false;
    };
  }, [credential, shareId]);
  // Pasting another guest link into this tab changes only the hash, which does not reload the
  // page; reload so the new invite is read instead of the one already captured.
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash !== "") window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {access === "checking" ? (
        <Notice title="Connecting..." />
      ) : access === "name" && credential !== null ? (
        <NameForm
          credential={credential}
          onJoined={() => {
            // The invite is spent; a remount must open the session, not the name form again.
            capturedEntry = { credential: null, shareId };
            setAccess("session");
          }}
        />
      ) : access === "session" && shareId !== null ? (
        <GuestSession shareId={shareId} />
      ) : (
        <Notice
          title="This link has ended or is not valid"
          detail="Ask the owner for a new link. Each link works in one browser."
        />
      )}
    </div>
  );
}

function GuestSession({ shareId }: { readonly shareId: string }) {
  const [stream, dispatch] = useReducer(applyGuestStreamEvent, null, () => ({
    ...initialGuestStreamState,
    awaitingRowIds: readAwaitingRowIds(),
  }));
  useEffect(() => writeAwaitingRowIds(stream.awaitingRowIds), [stream.awaitingRowIds]);
  // EventSource closes for good only on a non-200 response, which the guest routes send for a
  // missing, invalid, or ended session. Network drops reconnect on their own.
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    if (stream.view) document.title = stream.view.title;
  }, [stream.view]);

  useEffect(() => {
    const source = new EventSource(
      `${GUEST_ROUTE_PREFIX}/stream?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
    );
    source.addEventListener("message", (message) => {
      const event = parseGuestStreamEvent(message.data);
      if (event === null) return;
      dispatch(event);
      if (event.type === "ended") source.close();
    });
    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED) setRejected(true);
    });
    return () => source.close();
  }, [shareId]);

  if (stream.ended || (rejected && stream.view !== null)) {
    return <Notice title="This link has ended" detail="The owner stopped sharing this thread." />;
  }
  if (stream.view !== null) {
    return (
      <GuestThread view={stream.view} items={stream.items} awaitingRowIds={stream.awaitingRowIds} />
    );
  }
  if (!rejected) return <Notice title="Connecting..." />;
  return (
    <Notice
      title="This link has ended or is not valid"
      detail="Ask the owner for a new link. Each link works in one browser."
    />
  );
}

function Notice({ title, detail }: { readonly title: string; readonly detail?: string }) {
  return (
    <div className="m-auto flex max-w-sm flex-col gap-1 p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function NameForm({
  credential,
  onJoined,
}: {
  readonly credential: string;
  readonly onJoined: () => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || submitting) return;
    setSubmitting(true);
    const failure = await postGuest("redeem", { credential, name: trimmed });
    setSubmitting(false);
    if (failure === null) onJoined();
    else setError(failure);
  };
  return (
    <form className="m-auto flex w-full max-w-xs flex-col gap-3 p-6" onSubmit={submit}>
      <h1 className="text-base font-medium">Join a shared thread</h1>
      <label className="flex flex-col gap-1.5 text-sm" htmlFor="guest-name">
        Your name
        <Input
          id="guest-name"
          autoFocus
          autoComplete="name"
          maxLength={GUEST_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting || name.trim() === ""}>
        Join
      </Button>
      <p className="text-xs text-muted-foreground">
        The owner sees your name and approves each message before the agent gets it.
      </p>
    </form>
  );
}

function GuestThread({
  view: { shareId, title, working, expiresAt, messages },
  items,
  awaitingRowIds,
}: {
  readonly view: GuestShareView;
  readonly items: ReadonlyArray<GuestTranscriptItem>;
  readonly awaitingRowIds: GuestStreamState["awaitingRowIds"];
}) {
  const unplaced = unplacedGuestMessages(messages, items, awaitingRowIds);
  const ownMessageIds = new Set(messages.map((message) => message.id));
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        {working ? (
          <span className="flex items-center gap-1 text-xs text-info">
            <CircleDashedIcon aria-hidden className="size-3.5" />
            Working
          </span>
        ) : null}
        <ExpiryLabel expiresAt={expiresAt} />
      </header>
      {/* column-reverse keeps the view pinned to the newest reply while the reader is at the bottom. */}
      <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <ol className={cn(LANE, "flex flex-col gap-4 py-6")}>
          {groupGuestTranscript(items).map((row) =>
            row.kind === "work" ? (
              <li key={row.id}>
                <p className="truncate text-xs text-muted-foreground">{row.line}</p>
              </li>
            ) : (
              <li key={row.item.id}>
                <TranscriptItem item={row.item} ownMessageIds={ownMessageIds} shareId={shareId} />
              </li>
            ),
          )}
          {unplaced.map((message) => (
            <li key={message.id}>
              <UnplacedGuestMessage message={message} />
            </li>
          ))}
        </ol>
      </div>
      <div className={cn(LANE, "shrink-0 pb-4")}>
        <GuestComposer shareId={shareId} />
      </div>
    </>
  );
}

function ExpiryLabel({ expiresAt }: { readonly expiresAt: string }) {
  const nowMinute = useNowMinute();
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {formatGuestExpiry(expiresAt, Date.parse(`${nowMinute}Z`))}
    </span>
  );
}

const BUBBLE =
  "min-w-0 max-w-[80%] rounded-2xl p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]";

/** A guest message the owner has not sent yet, or chose not to send. */
function UnplacedGuestMessage({ message }: { readonly message: ThreadGuestMessage }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <GuestMessageName name="You" />
      <div
        className={cn(
          BUBBLE,
          guestBubbleClassName(message.status !== "sent"),
          message.status === "dismissed" ? "text-muted-foreground" : "text-message-foreground",
        )}
      >
        {message.text}
      </div>
      <p className="me-1 text-2xs text-muted-foreground">{STATUS_LABEL[message.status]}</p>
    </div>
  );
}

function TranscriptItem({
  item,
  ownMessageIds,
  shareId,
}: {
  readonly item: GuestTranscriptItem;
  readonly ownMessageIds: ReadonlySet<string>;
  readonly shareId: string;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1">
          {item.guestMessageId ? (
            <GuestMessageName
              name={ownMessageIds.has(item.guestMessageId) ? "You" : (item.guestName ?? "Guest")}
            />
          ) : null}
          <div
            className={cn(
              BUBBLE,
              "text-message-foreground",
              item.guestMessageId ? guestBubbleClassName(false) : "bg-message",
            )}
          >
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return <GuestMarkdown text={item.text} streaming={item.streaming} />;
    case "plan":
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Plan</span>
          <GuestMarkdown text={item.text} streaming={item.streaming} />
        </div>
      );
    case "question":
      return (
        <div className="flex flex-col gap-3 text-sm">
          {item.questions.map((question) => (
            <div key={question.question} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{question.header || "Question"}</span>
              <p>{question.question}</p>
              {question.options.length > 0 ? (
                <ul className="list-disc ps-5 text-muted-foreground">
                  {question.options.map((option) => (
                    <li key={option}>{option}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      );
    case "tool":
      return null;
    case "html-render":
      return <GuestHtmlRender item={item} shareId={shareId} />;
  }
}

/**
 * The app's renderer, so code, diagrams, and math look as they do for the owner. With no `cwd`,
 * thread, or environment, nothing in it can open files or reach the owner's machine.
 */
function GuestMarkdown({
  text,
  streaming,
}: {
  readonly text: string;
  readonly streaming: boolean;
}) {
  return (
    <ChatMarkdown
      text={text}
      cwd={undefined}
      isStreaming={streaming}
      parseRawHtml={false}
      className="text-foreground"
    />
  );
}

function GuestComposer({ shareId }: { readonly shareId: GuestShareView["shareId"] }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const trimmed = text.trim();
    if (trimmed === "" || sending) return;
    setSending(true);
    const failure = await postGuest("messages", { shareId, text: trimmed });
    setSending(false);
    setError(failure);
    // Keep anything typed while the request was in flight.
    if (failure === null) setText((current) => (current.trim() === trimmed ? "" : current));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Same as the app composer: Enter sends, Shift+Enter adds a line, IME composition is left alone.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-3xl border border-border bg-card px-4 pt-3 pb-2.5 shadow-composer dark:shadow-composer-dark"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        aria-label="Message"
        placeholder="Message"
        rows={2}
        maxLength={GUEST_MESSAGE_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-60 min-h-12 w-full resize-none bg-transparent text-sm outline-none field-sizing-content placeholder:text-placeholder"
      />
      <div className="flex items-center gap-3">
        {error !== null ? (
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            {error}
          </p>
        ) : (
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            The owner approves each message
          </p>
        )}
        <button
          type="submit"
          aria-label="Send"
          disabled={sending || text.trim() === ""}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs hover:bg-message-action-hover focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64"
        >
          <ArrowUpIcon aria-hidden className="size-4" />
        </button>
      </div>
    </form>
  );
}
