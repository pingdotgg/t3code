import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  AlarmClockIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  CheckCheckIcon,
  GitBranchIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useState, type KeyboardEvent, type MouseEvent } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { newMessageId } from "../../lib/utils";
import { useAssistantMessageText, useQuietThreadVisibleTurnItems } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { pickSnoozePreset, resolveSnoozePresets } from "../Sidebar.snooze";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { BoardCardRequest, BoardStatusLabel } from "./ThreadBoardCard";
import type { BoardCard } from "./threadBoard.logic";

/**
 * Triage one thread without leaving the board. Opening it subscribes to the thread's detail
 * for the latest message; closing it drops the subscription.
 */
export function ThreadBoardPeek(props: {
  card: BoardCard;
  project: ProjectFaviconProject & { readonly displayName: string };
  onClose: () => void;
  onOpenThread: () => void;
}) {
  const gt = useGT();
  const { card } = props;
  const { thread } = card;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const pullRequest = resolveThreadCurrentPullRequestLink(thread.pullRequests);

  return (
    <aside
      aria-label={gt("Thread details for {title}", { title: thread.title })}
      className="m-2 mr-0 flex w-100 shrink-0 flex-col overflow-hidden rounded-xl border bg-popover shadow-lg/5"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <ProjectFavicon project={props.project} className="size-3.5" />
            <span className="shrink-0 font-medium text-foreground">
              {props.project.displayName}
            </span>
            {thread.branch === null ? null : (
              <>
                <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate font-mono text-2xs">{thread.branch}</span>
              </>
            )}
            <span className="flex-1" />
            <Button size="xs" variant="outline" onClick={props.onOpenThread}>
              <T>Open thread</T>
              <ArrowUpRightIcon aria-hidden />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Close details")}
              onClick={props.onClose}
            >
              <XIcon />
            </Button>
          </div>
          <h2 className="text-base font-semibold leading-snug">{thread.title}</h2>
          <BoardStatusLabel card={card} />
        </div>

        {card.lane === "needs" ? (
          <BoardCardRequest
            card={card}
            threadRef={threadRef}
            pullRequestUrl={pullRequest?.url ?? null}
          />
        ) : null}

        <LatestExchange threadRef={threadRef} cwd={thread.worktreePath ?? undefined} />

        {pullRequest === null ? null : (
          <PullRequestRow threadRef={threadRef} url={pullRequest.url} number={pullRequest.number} />
        )}

        <PeekActions card={card} threadRef={threadRef} onDone={props.onClose} />
      </div>
      <FollowUpComposer card={card} threadRef={threadRef} />
    </aside>
  );
}

/**
 * The user's latest message and the agent's latest reply, in the order they were sent, so a
 * follow-up sent from the peek shows up at once below the reply it answers.
 */
function LatestExchange(props: { threadRef: ScopedThreadRef; cwd: string | undefined }) {
  const items = useQuietThreadVisibleTurnItems(props.threadRef);
  const userIndex = items.findLastIndex((entry) => entry.item.type === "user_message");
  const agentIndex = items.findLastIndex((entry) => entry.item.type === "assistant_message");
  const userItem = items[userIndex]?.item;
  const userText = userItem?.type === "user_message" ? userItem.text.trim() : "";
  const agentText = useAssistantMessageText(props.threadRef, items[agentIndex]?.item.id)?.trim();
  if (userText.length === 0 && !agentText) return null;

  const userMessage =
    userText.length === 0 ? null : (
      <div key="user" className="flex flex-col items-end gap-1">
        <span className="text-2xs font-medium text-muted-foreground">
          <T>You</T>
        </span>
        <p className="max-w-5/6 rounded-xl bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
          {userText}
        </p>
      </div>
    );
  const agentMessage = !agentText ? null : (
    <ChatMarkdown
      key="agent"
      text={agentText}
      cwd={props.cwd}
      threadRef={props.threadRef}
      environmentId={props.threadRef.environmentId}
      className="text-sm"
    />
  );
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold text-muted-foreground">
        <T>Latest messages</T>
      </h3>
      {userIndex > agentIndex ? [agentMessage, userMessage] : [userMessage, agentMessage]}
    </section>
  );
}

function PullRequestRow(props: { threadRef: ScopedThreadRef; url: string; number: number }) {
  const openPullRequest = useOpenPrLink(props.threadRef);
  return (
    <div>
      <Button
        size="xs"
        variant="outline"
        onClick={(event: MouseEvent<HTMLButtonElement>) =>
          openPullRequest(event, props.url, props.threadRef)
        }
      >
        <PullRequestGlyph.pullRequest aria-hidden />
        <T>
          Open pull request #<Var>{props.number}</Var>
        </T>
      </Button>
    </div>
  );
}

function PeekActions(props: { card: BoardCard; threadRef: ScopedThreadRef; onDone: () => void }) {
  const { card, threadRef } = props;
  const { thread } = card;
  const { settleThread, snoozeThread } = useThreadActions();
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const m = useMessages();
  const gt = useGT();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const activeRunId = thread.runtime?.activeRunId ?? null;
  const presets = snoozeOpen
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, threadRef.environmentId, m)
    : [];
  const snooze = (snoozedUntil: string) => {
    void snoozeThread(threadRef, snoozedUntil);
    props.onDone();
  };
  // oxlint-disable-next-line react/purity -- Read when the actions render; snooze eligibility only depends on time for queued turns.
  const snoozeAllowed = canSnooze(thread, { now: new Date().toISOString() });

  if (!canOperate) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {card.lane === "working" && activeRunId !== null ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void interrupt({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, runId: activeRunId },
            })
          }
        >
          <SquareIcon aria-hidden />
          <T>Stop</T>
        </Button>
      ) : null}
      {card.lane === "done" ? (
        <Button
          size="xs"
          variant="outline"
          title={gt("Marks the thread done and takes it off the board")}
          onClick={() => {
            void settleThread(threadRef);
            props.onDone();
          }}
        >
          <CheckCheckIcon aria-hidden />
          <T>Settle</T>
        </Button>
      ) : null}
      {snoozeAllowed ? (
        <Menu open={snoozeOpen} onOpenChange={setSnoozeOpen}>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                title={gt("Takes the thread off the board until it wakes")}
              />
            }
          >
            <AlarmClockIcon aria-hidden />
            <T>Snooze</T>
          </MenuTrigger>
          <MenuPopup side="bottom" align="start">
            {presets.map((preset) => (
              <MenuItem
                key={preset.id}
                onClick={() => {
                  const picked = pickSnoozePreset(
                    presets,
                    preset.id,
                    timestampFormat,
                    threadRef.environmentId,
                  );
                  if (picked) snooze(picked.snoozedUntil);
                }}
              >
                {preset.label}
                <MenuItemDetail>{preset.whenLabel}</MenuItemDetail>
              </MenuItem>
            ))}
            {presets.length > 0 ? <MenuSeparator /> : null}
            <MenuItem
              onClick={async () => {
                const choice = await requestCustomSnooze();
                if (choice) snooze(choice.snoozedUntil);
              }}
            >
              <T>Custom…</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

function FollowUpComposer(props: { card: BoardCard; threadRef: ScopedThreadRef }) {
  const { card, threadRef } = props;
  const gt = useGT();
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = card.lane === "working";

  const send = async () => {
    const message = text.trim();
    if (!canOperate || sending || message.length === 0) return;
    setSending(true);
    setError(null);
    const result = await startTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
        runtimeMode: card.thread.runtimeMode,
        interactionMode: card.thread.interactionMode,
        // A running thread gets the message as its next turn; nothing is interrupted.
        dispatchMode: running ? "queue" : "auto",
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Could not send your message."));
    } else {
      setText("");
    }
    setSending(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  if (!canOperate) return null;
  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2">
        <Textarea
          className="min-w-0 flex-1"
          rows={2}
          value={text}
          disabled={sending}
          aria-label={gt("Message {title}", { title: card.thread.title })}
          placeholder={running ? gt("Queue a follow-up…") : gt("Send a follow-up…")}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <Button
          size="icon-sm"
          aria-label={running ? gt("Queue message") : gt("Send message")}
          disabled={sending || text.trim().length === 0}
          onClick={() => void send()}
        >
          <ArrowUpIcon />
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="mt-1.5 text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
