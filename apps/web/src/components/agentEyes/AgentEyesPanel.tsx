import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AgentEyesDetail } from "@t3tools/contracts/settings";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  RadioIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";

import {
  AGENT_EYES_KIND_LABELS,
  agentEyesPlayback,
  bodyForDetail,
  deriveAgentEyesEvents,
  filterAgentEyesEvents,
  INITIAL_AGENT_EYES_PLAYBACK,
  stagedEvent,
  type AgentEyesEvent,
  type AgentEyesKind,
} from "../../agentEyes.logic";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useQuietThreadProjection } from "../../state/entities";
import { useTurnItemDetail } from "../../state/queries";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
} from "@t3tools/client-runtime/work-log/item-detail";
import { gameDevEnvironment } from "../../state/gameDev";
import { useEnvironmentQuery } from "../../state/query";
import { GameCaptureImage } from "../gameDev/GameCaptureImage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const REPLAY_STEP_MS = 1600;
const DETAIL_LABELS: Record<AgentEyesDetail, string> = {
  summary: "Summary",
  standard: "Standard",
  full: "Full",
};
const STATUS_LABELS: Record<AgentEyesEvent["status"], string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
};

/**
 * Agent Eyes: follows what the agent does in this thread, from the thread's own activity. It reads
 * nothing the thread does not already have, so watching costs no model usage.
 */
export function AgentEyesPanel({
  threadRef,
  visible,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const projection = useQuietThreadProjection(threadRef);
  const turnItems = projection?.projection.turnItems;
  const messages = projection?.projection.messages;
  const events = deriveAgentEyesEvents(
    turnItems ?? [],
    (messageId) => messages?.findLast((message) => message.id === messageId)?.text,
  );
  const detail = useClientSettings((settings) => settings.agentEyesDetail);
  const [playback, dispatch] = useReducer(agentEyesPlayback, INITIAL_AGENT_EYES_PLAYBACK);
  const [kinds, setKinds] = useState<ReadonlySet<AgentEyesKind>>(new Set());
  const [query, setQuery] = useState("");
  const shown = filterAgentEyesEvents(events, { kinds, query });
  const staged = stagedEvent(shown.length > 0 ? shown : events, playback);
  const tick = useEffectEvent(() => dispatch({ type: "tick", events: shown }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- advances the replay on a timer while it runs and the panel is visible
  useEffect(() => {
    if (playback.mode !== "replay" || !visible) return;
    const timer = window.setInterval(() => tick(), REPLAY_STEP_MS);
    return () => window.clearInterval(timer);
  }, [playback.mode, visible]);

  const toggleKind = (kind: AgentEyesKind) =>
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  const presentKinds = (Object.keys(AGENT_EYES_KIND_LABELS) as AgentEyesKind[]).filter((kind) =>
    events.some((event) => event.kind === kind),
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-agent-eyes>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/70 px-3 py-2">
        <Badge variant={playback.mode === "live" ? "success" : "secondary"}>
          {playback.mode === "live"
            ? "Following live"
            : playback.mode === "replay"
              ? "Replaying"
              : "Paused"}
        </Badge>
        <div className="ms-auto flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous action"
            disabled={shown.length === 0}
            onClick={() => dispatch({ type: "step", events: shown, offset: -1 })}
          >
            <ChevronLeftIcon />
          </Button>
          {playback.mode === "live" ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Pause"
              disabled={staged === null}
              onClick={() => dispatch({ type: "pause", eventId: staged?.id ?? null })}
            >
              <PauseIcon />
            </Button>
          ) : (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Follow live"
              onClick={() => dispatch({ type: "follow" })}
            >
              <RadioIcon />
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next action"
            disabled={shown.length === 0}
            onClick={() => dispatch({ type: "step", events: shown, offset: 1 })}
          >
            <ChevronRightIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={playback.mode === "replay" ? "Pause replay" : "Replay from the start"}
            disabled={shown.length === 0}
            onClick={() =>
              playback.mode === "replay"
                ? dispatch({ type: "pause", eventId: staged?.id ?? null })
                : dispatch({ type: "replay", firstEventId: shown[0]?.id ?? null })
            }
          >
            {playback.mode === "replay" ? <PauseIcon /> : <RotateCcwIcon />}
          </Button>
          <select
            aria-label="Agent Eyes detail"
            className="h-6 rounded-md border border-border bg-background px-1 text-xs"
            value={detail}
            onChange={(event) =>
              void updateClientSettings({
                agentEyesDetail: event.currentTarget.value as AgentEyesDetail,
              })
            }
          >
            {(Object.keys(DETAIL_LABELS) as AgentEyesDetail[]).map((level) => (
              <option key={level} value={level}>
                {DETAIL_LABELS[level]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {staged === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Nothing to watch yet. When the agent edits files, runs commands, or uses the browser, it
          shows up here as it happens.
        </div>
      ) : (
        <>
          <section aria-label="Current action" className="flex min-h-0 flex-[3] flex-col">
            <div className="flex shrink-0 items-center gap-2 px-3 pt-2 text-xs">
              <Badge variant="outline">{AGENT_EYES_KIND_LABELS[staged.kind]}</Badge>
              <span className="min-w-0 flex-1 truncate font-medium" data-agent-eyes-title>
                {staged.title}
              </span>
              <Badge variant={staged.status === "failed" ? "error" : "secondary"}>
                {STATUS_LABELS[staged.status]}
              </Badge>
            </div>
            <AgentEyesBody
              event={staged}
              detail={detail}
              item={turnItems?.find((candidate) => candidate.id === staged.id) ?? null}
              threadRef={threadRef}
            />
          </section>

          <section
            aria-label="What happened"
            className="shrink-0 border-y border-border/70 bg-muted/40 px-3 py-2 text-xs"
            data-agent-eyes-explanation
          >
            <p className="font-medium text-foreground">What happened</p>
            <p className="text-muted-foreground">{staged.summary}</p>
            {detail !== "summary" && staged.agentSaid ? (
              <p className="mt-1 text-muted-foreground">
                <span className="font-medium text-foreground">The agent said before this: </span>“
                {staged.agentSaid}”
              </p>
            ) : null}
          </section>
        </>
      )}

      <section aria-label="Timeline" className="flex min-h-0 flex-[2] flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 py-2">
          <div className="min-w-32 flex-1">
            <Input
              aria-label="Search actions"
              placeholder="Search actions"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          {presentKinds.map((kind) => (
            <Button
              key={kind}
              size="xs"
              variant={kinds.has(kind) ? "secondary" : "ghost"}
              aria-pressed={kinds.has(kind)}
              onClick={() => toggleKind(kind)}
            >
              {AGENT_EYES_KIND_LABELS[kind]}
            </Button>
          ))}
        </div>
        <ol className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" data-agent-eyes-timeline>
          {shown.length === 0 ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">No matching actions.</li>
          ) : (
            shown.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-xs hover:bg-accent",
                    event.id === staged?.id && "bg-accent",
                  )}
                  onClick={() => dispatch({ type: "select", eventId: event.id })}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      event.status === "failed"
                        ? "bg-destructive"
                        : event.status === "running"
                          ? "bg-primary"
                          : "bg-muted-foreground/50",
                    )}
                  />
                  <span className="w-16 shrink-0 text-muted-foreground">
                    {AGENT_EYES_KIND_LABELS[event.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{event.title}</span>
                </button>
              </li>
            ))
          )}
        </ol>
      </section>
    </div>
  );
}

type TurnItem = NonNullable<
  ReturnType<typeof useQuietThreadProjection>
>["projection"]["turnItems"][number];

function AgentEyesBody({
  event,
  detail,
  item,
  threadRef,
}: {
  readonly event: AgentEyesEvent;
  readonly detail: AgentEyesDetail;
  readonly item: TurnItem | null;
  readonly threadRef: ScopedThreadRef;
}) {
  // The thread carries command and tool output only on request, like the timeline's inspector.
  const wireItem =
    item !== null && (item.type === "command_execution" || item.type === "dynamic_tool")
      ? item
      : null;
  const fetched = useTurnItemDetail(
    wireItem !== null && turnItemNeedsDetailFetch(wireItem)
      ? {
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          itemId: wireItem.id,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
    undefined,
  );
  const loaded = fetched.data?.item;
  const fullEvent =
    loaded && loaded.type === wireItem?.type
      ? (deriveAgentEyesEvents([loaded])[0] ?? event)
      : event;
  const fullBody = fullEvent.body;
  const captureId = fullEvent.captureId ?? null;
  const capture = useEnvironmentQuery(
    captureId === null
      ? null
      : gameDevEnvironment.capture({
          environmentId: threadRef.environmentId,
          input: { captureId },
        }),
  );
  const body = bodyForDetail(fullBody, detail);
  const scrollRef = useRef<HTMLPreElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the newest output in view as a running command streams
  useEffect(() => {
    const element = scrollRef.current;
    if (element && event.kind !== "edit" && body !== "") element.scrollTop = element.scrollHeight;
  }, [body, event.kind]);
  if (capture.data) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <GameCaptureImage capture={capture.data} label="Captured game viewport" />
      </div>
    );
  }
  if (body.trim() === "") {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No output to show.</p>;
  }
  return (
    <pre
      ref={scrollRef}
      className="m-3 mt-2 min-h-0 flex-1 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-2xs leading-relaxed"
      data-agent-eyes-body
    >
      {event.kind === "edit"
        ? body.split("\n").map((line, index) => (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- diff lines have no identity beyond their position
              key={index}
              className={cn(
                "block",
                line.startsWith("+") && !line.startsWith("+++") && "bg-diff-addition/20",
                line.startsWith("-") && !line.startsWith("---") && "bg-diff-deletion/20",
              )}
            >
              {line || " "}
            </span>
          ))
        : body}
    </pre>
  );
}
