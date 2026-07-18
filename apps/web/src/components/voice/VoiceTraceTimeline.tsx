import {
  BotIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  Globe2Icon,
  MessageCircleIcon,
  Settings2Icon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import type { VoiceTraceEntry } from "./voiceTraceStore";

function isToolEntry(kind: VoiceTraceEntry["kind"]): boolean {
  return kind === "tool_call" || kind === "tool_result" || kind === "server_tool";
}

function TraceTime({ timestamp }: { readonly timestamp: VoiceTraceEntry["timestamp"] }) {
  return (
    <time className="ml-auto shrink-0 font-normal text-[10px] text-muted-foreground">
      {new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </time>
  );
}

function TraceContent({ entry }: { readonly entry: VoiceTraceEntry }) {
  return (
    <>
      {entry.text ? (
        <p className="mt-1.5 whitespace-pre-wrap break-words leading-relaxed text-foreground/75">
          {entry.text}
        </p>
      ) : null}
      {entry.details ? (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words border-l border-border/70 pl-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {entry.details}
        </pre>
      ) : null}
    </>
  );
}

function TraceIcon({ kind }: { readonly kind: VoiceTraceEntry["kind"] }) {
  const className = "size-3.5";
  switch (kind) {
    case "user":
      return <MessageCircleIcon className={className} />;
    case "assistant":
      return <BotIcon className={className} />;
    case "server_tool":
      return <Globe2Icon className={className} />;
    case "tool_call":
    case "tool_result":
      return <WrenchIcon className={className} />;
    case "error":
      return <CircleAlertIcon className={className} />;
    case "system":
      return <Settings2Icon className={className} />;
  }
}

export function VoiceTraceTimeline({
  entries,
  streamingAssistantText,
  className,
}: {
  readonly entries: readonly VoiceTraceEntry[];
  readonly streamingAssistantText?: string | undefined;
  readonly className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries, streamingAssistantText]);

  return (
    <div
      ref={scrollRef}
      className={cn("min-h-0 overflow-y-auto overscroll-contain", className)}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinnedToBottomRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      <div className="divide-y divide-border/50">
        {entries.length === 0 && !streamingAssistantText ? (
          <p className="px-3.5 py-8 text-center text-xs text-muted-foreground">
            Conversation and tool activity will appear here.
          </p>
        ) : null}
        {entries.map((entry) =>
          isToolEntry(entry.kind) ? (
            <details key={entry.id} className="group text-xs">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3.5 py-2.5 font-medium marker:hidden hover:bg-muted/25">
                <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                <TraceIcon kind={entry.kind} />
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                <TraceTime timestamp={entry.timestamp} />
              </summary>
              <div className="border-t border-border/35 bg-muted/10 px-8 py-2.5">
                <TraceContent entry={entry} />
              </div>
            </details>
          ) : (
            <div
              key={entry.id}
              className={cn(
                "px-3.5 py-2.5 text-xs",
                entry.kind === "error" && "bg-destructive/5 text-destructive",
              )}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <TraceIcon kind={entry.kind} />
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                <TraceTime timestamp={entry.timestamp} />
              </div>
              <TraceContent entry={entry} />
            </div>
          ),
        )}
        {streamingAssistantText ? (
          <div className="bg-primary/5 px-3.5 py-2.5 text-xs">
            <div className="flex items-center gap-1.5 font-medium">
              <BotIcon className="size-3.5" />
              OpenAI
              <span className="ml-auto text-[10px] font-normal text-muted-foreground">Live</span>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap break-words leading-relaxed text-foreground/75">
              {streamingAssistantText}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
