import type {
  OrchestrationV2DomainEvent,
  ModelSelection,
  OrchestrationV2PlanStep,
  OrchestrationV2Run,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2UserInputQuestion,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getPrimaryEnvironmentConnection } from "../environments/runtime";
import { newCommandId, newMessageId, newProjectId, newThreadId } from "../lib/utils";

export const Route = createFileRoute("/debug/orchestration-v2")({
  component: OrchestrationV2DebugRoute,
});

const DEFAULT_PROMPT = "Respond with the following text: fixture simple ok";
const DEFAULT_MODEL_SELECTION = {
  provider: "codex",
  model: "gpt-5.4",
} satisfies ModelSelection;

type LogEntry =
  | {
      readonly type: "command";
      readonly label: string;
      readonly value: unknown;
    }
  | {
      readonly type: "stream";
      readonly value: OrchestrationV2ThreadStreamItem;
    }
  | {
      readonly type: "error";
      readonly message: string;
    };

interface TimelineEntry {
  readonly key: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly status?: string | undefined;
  readonly body?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly sequence?: number | undefined;
  readonly raw: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatLabel(value: string): string {
  return value
    .split(/[._-]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function compactId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function stringifyShort(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  const raw = typeof value === "string" ? value : String(value);
  const wrapped = /^DateTime\.(?:Utc|Zoned|Local)\((.+)\)$/.exec(raw);
  const iso = wrapped?.[1] ?? raw;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString();
}

function formatRelative(fromMs: number, nowMs: number): string {
  const diff = nowMs - fromMs;
  const abs = Math.abs(diff);
  if (abs < 1000) return "just now";
  const future = diff < 0;
  const sec = Math.round(abs / 1000);
  if (sec < 60) return future ? `in ${sec}s` : `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return future ? `in ${hr}h` : `${hr}h ago`;
  const day = Math.round(hr / 24);
  return future ? `in ${day}d` : `${day}d ago`;
}

function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

function Timestamp(props: { readonly iso: string | undefined; readonly nowMs: number }) {
  if (props.iso === undefined) return null;
  const parsed = new Date(props.iso);
  if (Number.isNaN(parsed.getTime())) {
    return (
      <span className="font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground">
        {props.iso}
      </span>
    );
  }
  const clock = parsed.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return (
    <time
      dateTime={props.iso}
      title={props.iso}
      className="font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground"
    >
      {clock} · {formatRelative(parsed.getTime(), props.nowMs)}
    </time>
  );
}

function readText(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function buildProjectionTimeline(
  projection: OrchestrationV2ThreadProjection | null,
): ReadonlyArray<TimelineEntry> {
  if (projection === null) {
    return [];
  }

  const entries: Array<TimelineEntry & { readonly sort: number }> = [
    {
      key: `thread:${projection.thread.id}`,
      eyebrow: "Thread",
      title: projection.thread.title,
      subtitle: `${projection.thread.modelSelection.provider} / ${projection.thread.modelSelection.model}`,
      status: projection.thread.archivedAt ? "archived" : "active",
      timestamp: formatTimestamp(projection.thread.createdAt),
      raw: projection.thread,
      sort: 0,
    },
  ];

  projection.messages.forEach((message, index) => {
    entries.push({
      key: `message:${message.id}`,
      eyebrow: "Message",
      title: formatLabel(message.role),
      subtitle: compactId(message.id),
      status: message.streaming ? "streaming" : "completed",
      body: message.text,
      timestamp: formatTimestamp(message.createdAt),
      raw: message,
      sort: 100 + index,
    });
  });

  projection.runs.forEach((run, index) => {
    entries.push({
      key: `run:${run.id}`,
      eyebrow: "Run",
      title: `Run ${run.ordinal}`,
      subtitle: run.provider,
      status: run.status,
      timestamp: formatTimestamp(run.startedAt ?? run.requestedAt),
      raw: run,
      sort: 200 + index * 100,
    });
  });

  projection.turnItems.forEach((item) => {
    const record = item as unknown as Record<string, unknown>;
    const body =
      readText(record, ["text", "markdown", "detail", "explanation", "output"]) ??
      stringifyShort(record.input);
    entries.push({
      key: `turn-item:${item.id}`,
      eyebrow: "Turn Item",
      title: formatLabel(item.type),
      subtitle: compactId(item.providerTurnId),
      status: item.status,
      body,
      timestamp: formatTimestamp(item.updatedAt ?? item.startedAt),
      raw: item,
      sort: 250 + item.ordinal,
    });
  });

  projection.runtimeRequests.forEach((request, index) => {
    entries.push({
      key: `request:${request.id}`,
      eyebrow: "Request",
      title: formatLabel(request.kind),
      subtitle: compactId(request.providerTurnId),
      status: request.status,
      timestamp: formatTimestamp(request.createdAt),
      raw: request,
      sort: 500 + index,
    });
  });

  projection.checkpoints.forEach((checkpoint, index) => {
    entries.push({
      key: `checkpoint:${checkpoint.id}`,
      eyebrow: "Checkpoint",
      title: compactId(checkpoint.ref) ?? compactId(checkpoint.id) ?? "Checkpoint",
      subtitle: compactId(checkpoint.scopeId),
      status: checkpoint.status,
      timestamp: formatTimestamp(checkpoint.capturedAt),
      raw: checkpoint,
      sort: 700 + index,
    });
  });

  return entries.toSorted((left, right) => left.sort - right.sort);
}

function upsertProjectionEntity<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) {
    return [...items, item];
  }
  const next = [...items];
  next[index] = item;
  return next;
}

function applyStreamEventToProjection(
  projection: OrchestrationV2ThreadProjection | null,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection | null {
  if (projection === null || event.threadId !== projection.thread.id) {
    return projection;
  }

  const base = {
    ...projection,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "thread.created":
      return { ...base, thread: event.payload };
    case "run.created":
    case "run.updated":
      return { ...base, runs: upsertProjectionEntity(base.runs, event.payload) };
    case "run-attempt.created":
    case "run-attempt.updated":
      return { ...base, attempts: upsertProjectionEntity(base.attempts, event.payload) };
    case "node.updated":
      return { ...base, nodes: upsertProjectionEntity(base.nodes, event.payload) };
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertProjectionEntity(base.providerSessions, event.payload),
      };
    case "provider-thread.updated":
      return {
        ...base,
        providerThreads: upsertProjectionEntity(base.providerThreads, event.payload),
      };
    case "provider-turn.updated":
      return {
        ...base,
        providerTurns: upsertProjectionEntity(base.providerTurns, event.payload),
      };
    case "runtime-request.updated":
      return {
        ...base,
        runtimeRequests: upsertProjectionEntity(base.runtimeRequests, event.payload),
      };
    case "message.updated":
      return { ...base, messages: upsertProjectionEntity(base.messages, event.payload) };
    case "plan.updated":
      return { ...base, plans: upsertProjectionEntity(base.plans, event.payload) };
    case "turn-item.updated":
      return { ...base, turnItems: upsertProjectionEntity(base.turnItems, event.payload) };
    case "checkpoint-scope.created":
      return {
        ...base,
        checkpointScopes: upsertProjectionEntity(base.checkpointScopes, event.payload),
      };
    case "checkpoint.captured":
      return { ...base, checkpoints: upsertProjectionEntity(base.checkpoints, event.payload) };
    case "context-handoff.updated":
      return {
        ...base,
        contextHandoffs: upsertProjectionEntity(base.contextHandoffs, event.payload),
      };
  }

  return base;
}

function buildStreamTimeline(logEntries: ReadonlyArray<LogEntry>): ReadonlyArray<TimelineEntry> {
  return logEntries.map((entry, index) => {
    if (entry.type === "error") {
      return {
        key: `log:${index}`,
        eyebrow: "Error",
        title: "Error",
        status: "failed",
        body: entry.message,
        raw: entry,
      };
    }

    if (entry.type === "command") {
      return {
        key: `log:${index}`,
        eyebrow: "Command",
        title: entry.label,
        status: "sent",
        raw: entry.value,
      };
    }

    const value = entry.value;
    if (value.kind === "snapshot") {
      return {
        key: `log:${index}`,
        eyebrow: "Snapshot",
        title: "Projection Snapshot",
        subtitle: `sequence ${value.snapshotSequence}`,
        sequence: value.snapshotSequence,
        status: "received",
        raw: value,
      };
    }

    const event = value.event;
    const payload: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
    return {
      key: `log:${index}`,
      eyebrow: "Event",
      title: event.type,
      subtitle: compactId(event.threadId),
      sequence: value.sequence,
      status: stringifyShort(payload.status) ?? stringifyShort(event.provider) ?? "received",
      body: readText(payload, ["text", "title", "detail", "markdown"]),
      raw: value,
    };
  });
}

function turnItemBody(item: OrchestrationV2TurnItem): string | undefined {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list": {
      const steps = item.steps.map((step) => `${step.status}: ${step.text}`).join("\n");
      return [item.explanation, steps].filter(Boolean).join("\n\n") || undefined;
    }
    case "user_input_request":
      return item.questions.map((question) => question.question).join("\n");
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} / -${item.deletions ?? 0}`,
        item.diffStr,
      ]
        .filter(Boolean)
        .join("\n");
    case "command_execution":
      return [item.input, item.output].filter(Boolean).join("\n\n");
    case "file_search":
      return [
        item.pattern,
        item.results
          ?.map((result) =>
            [result.fileName, result.line === undefined ? undefined : `:${result.line}`].join(""),
          )
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n");
    case "web_search":
      return [
        item.patterns?.join(", "),
        item.results?.map((result) => result.title ?? result.url ?? result.snippet).join("\n"),
      ]
        .filter(Boolean)
        .join("\n");
    case "approval_request":
      return item.prompt ?? formatLabel(item.requestKind);
    case "checkpoint":
      return item.files
        .map((file) => `${file.path} +${file.additions} / -${file.deletions}`)
        .join("\n");
    case "run_interrupt_request":
    case "run_interrupt_result":
      return item.message;
    case "compaction":
      return item.summary;
    case "handoff":
      return item.summary;
    case "fork":
      return `Target thread: ${compactId(item.targetThreadId) ?? item.targetThreadId}`;
    case "dynamic_tool":
      return [item.toolName, stringifyShort(item.output) ?? stringifyShort(item.input)]
        .filter(Boolean)
        .join("\n");
  }
}

interface ItemTimelineRow {
  readonly item: OrchestrationV2TurnItem;
  readonly entry: TimelineEntry;
}

interface QueuedRunRow {
  readonly run: OrchestrationV2Run;
  readonly messageText: string;
}

function buildItemTimeline(input: {
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly logEntries: ReadonlyArray<LogEntry>;
}): ReadonlyArray<ItemTimelineRow> {
  const items = new Map<
    string,
    {
      readonly item: OrchestrationV2TurnItem;
      readonly sequence?: number | undefined;
    }
  >();

  const upsert = (item: OrchestrationV2TurnItem, sequence?: number) => {
    const existing = items.get(item.id);
    items.set(item.id, {
      item,
      ...(sequence === undefined
        ? existing?.sequence === undefined
          ? {}
          : { sequence: existing.sequence }
        : { sequence }),
    });
  };

  for (const entry of input.logEntries) {
    if (entry.type !== "stream") {
      continue;
    }
    const value = entry.value;
    if (value.kind === "snapshot") {
      for (const item of value.projection.turnItems) {
        upsert(item, value.snapshotSequence);
      }
      continue;
    }
    if (value.event.type === "turn-item.updated") {
      upsert(value.event.payload, value.sequence);
    }
  }

  if (input.projection !== null) {
    for (const item of input.projection.turnItems) {
      upsert(item);
    }
  }

  return [...items.values()]
    .toSorted((left, right) => left.item.ordinal - right.item.ordinal)
    .map(({ item, sequence }) => ({
      item,
      entry: {
        key: `item:${item.id}`,
        eyebrow: `Item ${item.ordinal}`,
        title: item.title?.trim() || formatLabel(item.type),
        subtitle: `${formatLabel(item.type)} · ${compactId(item.id) ?? item.id}`,
        status: item.status,
        body: turnItemBody(item),
        timestamp: formatTimestamp(item.updatedAt ?? item.completedAt ?? item.startedAt),
        sequence,
        raw: item,
      },
    }));
}

const PANEL_KEYS = ["projection", "item", "stream"] as const;
type PanelKey = (typeof PANEL_KEYS)[number];
const ALL_PANEL_KEYS: ReadonlyArray<PanelKey> = PANEL_KEYS;
const DEFAULT_VISIBLE_PANELS: ReadonlyArray<PanelKey> = ["item", "stream"];

const PANEL_TITLES: Record<PanelKey, string> = {
  projection: "Projection Timeline",
  item: "Item Timeline",
  stream: "Stream Timeline",
};

const PANEL_DND_MIME = "application/x-t3-panel-key";

function readDraggedPanelKey(event: DragEvent<HTMLElement>): PanelKey | null {
  const raw = event.dataTransfer.getData(PANEL_DND_MIME);
  return ALL_PANEL_KEYS.includes(raw as PanelKey) ? (raw as PanelKey) : null;
}

function computePanelDropSide(event: DragEvent<HTMLDivElement>): "before" | "after" {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientX - rect.left < rect.width / 2 ? "before" : "after";
}

function DragHandleIcon(props: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 10 16"
      fill="currentColor"
      className={props.className ?? "size-3.5"}
    >
      <circle cx="3" cy="3" r="1.2" />
      <circle cx="7" cy="3" r="1.2" />
      <circle cx="3" cy="8" r="1.2" />
      <circle cx="7" cy="8" r="1.2" />
      <circle cx="3" cy="13" r="1.2" />
      <circle cx="7" cy="13" r="1.2" />
    </svg>
  );
}

function CloseIcon(props: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={props.className ?? "size-3.5"}
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function PanelHost(props: {
  readonly visiblePanels: ReadonlyArray<PanelKey>;
  readonly hiddenPanels: ReadonlyArray<PanelKey>;
  readonly renderPanel: (key: PanelKey) => ReactNode;
  readonly onReorder: (source: PanelKey, target: PanelKey, side: "before" | "after") => void;
  readonly onRestoreAtEnd: (source: PanelKey) => void;
}) {
  const visibleCount = props.visiblePanels.length;
  const minWidthRem = Math.max(28, 28 * visibleCount);
  const gridStyle: CSSProperties = {
    gridTemplateColumns:
      visibleCount === 0 ? "minmax(0,1fr)" : `repeat(${visibleCount}, minmax(0, 1fr))`,
    minWidth: `${minWidthRem}rem`,
  };

  const [draggingOverEnd, setDraggingOverEnd] = useState(false);

  const handleContainerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(PANEL_DND_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDraggingOverEnd(true);
  };

  const handleContainerDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget === event.target) {
      setDraggingOverEnd(false);
    }
  };

  const handleContainerDrop = (event: DragEvent<HTMLDivElement>) => {
    const sourceKey = readDraggedPanelKey(event);
    setDraggingOverEnd(false);
    if (sourceKey === null) return;
    event.preventDefault();
    props.onRestoreAtEnd(sourceKey);
  };

  if (visibleCount === 0) {
    return (
      <section
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
        className={`flex min-h-0 min-w-0 items-center justify-center rounded-md border border-dashed p-8 text-center text-base text-muted-foreground sm:text-sm ${
          draggingOverEnd ? "border-sky-400 bg-sky-50/40" : "border-border/60 bg-card/20"
        }`}
      >
        <p className="max-w-sm text-pretty">
          No panels visible. Click a pill in the header to restore it, or drag one here.
        </p>
      </section>
    );
  }

  return (
    <section
      className="min-h-0 min-w-0 overflow-x-auto overflow-y-hidden pb-1"
      onDragOver={handleContainerDragOver}
      onDragLeave={handleContainerDragLeave}
      onDrop={handleContainerDrop}
    >
      <div className="grid h-full min-h-0 w-full gap-4" style={gridStyle}>
        {props.visiblePanels.map((panelKey) => (
          <PanelDropSlot key={panelKey} panelKey={panelKey} onReorder={props.onReorder}>
            {props.renderPanel(panelKey)}
          </PanelDropSlot>
        ))}
      </div>
    </section>
  );
}

function PanelDropSlot(props: {
  readonly panelKey: PanelKey;
  readonly onReorder: (source: PanelKey, target: PanelKey, side: "before" | "after") => void;
  readonly children: ReactNode;
}) {
  const [dropSide, setDropSide] = useState<"before" | "after" | null>(null);

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(PANEL_DND_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropSide(computePanelDropSide(event));
  };

  const handleDragLeave = () => {
    setDropSide(null);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const sourceKey = readDraggedPanelKey(event);
    const side = dropSide ?? computePanelDropSide(event);
    setDropSide(null);
    if (sourceKey === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (sourceKey === props.panelKey) return;
    props.onReorder(sourceKey, props.panelKey, side);
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative grid min-h-0 min-w-0 grid-rows-1"
    >
      {dropSide === "before" ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 -left-2 w-1 rounded-full bg-sky-500"
        />
      ) : null}
      {dropSide === "after" ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 -right-2 w-1 rounded-full bg-sky-500"
        />
      ) : null}
      {props.children}
    </div>
  );
}

function HiddenPanelPills(props: {
  readonly hiddenPanels: ReadonlyArray<PanelKey>;
  readonly onRestore: (key: PanelKey) => void;
}) {
  if (props.hiddenPanels.length === 0) return null;
  return (
    <ul role="list" className="flex flex-wrap items-center gap-1.5">
      {props.hiddenPanels.map((key) => (
        <li key={key}>
          <HiddenPanelPill panelKey={key} onRestore={props.onRestore} />
        </li>
      ))}
    </ul>
  );
}

function HiddenPanelPill(props: {
  readonly panelKey: PanelKey;
  readonly onRestore: (key: PanelKey) => void;
}) {
  const handleDragStart = (event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData(PANEL_DND_MIME, props.panelKey);
    event.dataTransfer.effectAllowed = "move";
  };
  return (
    <button
      type="button"
      draggable
      onDragStart={handleDragStart}
      onClick={() => {
        props.onRestore(props.panelKey);
      }}
      className="inline-flex cursor-grab items-center gap-1.5 rounded-full border border-dashed border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
      title={`Restore ${PANEL_TITLES[props.panelKey]}`}
    >
      <DragHandleIcon className="size-3 opacity-60" />
      <span>{PANEL_TITLES[props.panelKey]}</span>
    </button>
  );
}

function ThreadStatusInline(props: {
  readonly threadId: ThreadId | null;
  readonly provider: string;
  readonly model: string;
  readonly streamCount: number;
}) {
  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <div className="flex items-baseline gap-1.5">
        <dt className="text-muted-foreground">Thread</dt>
        <dd className="font-mono">{compactId(props.threadId) ?? "—"}</dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="text-muted-foreground">Model</dt>
        <dd>
          <span>{props.provider}</span>
          <span className="mx-1 text-muted-foreground">/</span>
          <span className="font-mono">{props.model}</span>
        </dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="text-muted-foreground">Stream</dt>
        <dd className="tabular-nums">
          {props.streamCount}
          <span className="ml-1 text-muted-foreground">items</span>
        </dd>
      </div>
    </dl>
  );
}

function QueueControls(props: {
  readonly rows: ReadonlyArray<QueuedRunRow>;
  readonly activeTurn: ActiveTurn | null;
  readonly disabled: boolean;
  readonly onPromote: (runId: RunId) => void;
  readonly onReorder: (runId: RunId, beforeRunId: RunId | null) => void;
}) {
  if (props.rows.length === 0) {
    return null;
  }

  return (
    <section className="mt-3 rounded-md border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Queue</h2>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
          {props.rows.length}
        </span>
      </header>
      <ol role="list" className="max-h-36 overflow-auto px-2 py-1.5">
        {props.rows.map((row, index) => {
          const previous = props.rows[index - 1];
          const afterNext = props.rows[index + 2];
          const canPromote = props.activeTurn !== null;
          return (
            <li
              key={row.run.id}
              className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1 py-1 text-sm"
            >
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {row.run.queuePosition ?? row.run.ordinal}
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium">{row.messageText}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  Run {row.run.ordinal} · {compactId(row.run.id)}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <QueueActionButton
                  label="Move up"
                  disabled={props.disabled || previous === undefined}
                  onClick={() => {
                    if (previous !== undefined) {
                      props.onReorder(row.run.id, previous.run.id);
                    }
                  }}
                >
                  ↑
                </QueueActionButton>
                <QueueActionButton
                  label="Move down"
                  disabled={props.disabled || index === props.rows.length - 1}
                  onClick={() => {
                    props.onReorder(row.run.id, afterNext?.run.id ?? null);
                  }}
                >
                  ↓
                </QueueActionButton>
                <button
                  type="button"
                  disabled={props.disabled || !canPromote}
                  onClick={() => {
                    props.onPromote(row.run.id);
                  }}
                  className="inline-flex h-7 items-center rounded-md border border-sky-200 bg-sky-50 px-2 text-xs font-medium text-sky-900 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground hover:bg-sky-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                  title={canPromote ? "Promote queued message to steer" : "No active run to steer"}
                >
                  Steer
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function QueueActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="inline-flex size-7 items-center justify-center rounded-md border border-border text-xs text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
    >
      {props.children}
    </button>
  );
}

function PanelHeader(props: {
  readonly title: string;
  readonly panelKey?: PanelKey | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly trailing?: ReactNode;
}) {
  const { panelKey, onClose } = props;
  const handleDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      if (panelKey === undefined) return;
      event.dataTransfer.setData(PANEL_DND_MIME, panelKey);
      event.dataTransfer.effectAllowed = "move";
    },
    [panelKey],
  );

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-2 sm:px-3">
      {panelKey === undefined ? null : (
        <button
          type="button"
          draggable
          onDragStart={handleDragStart}
          aria-label={`Drag ${props.title} to reorder`}
          className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-muted hover:text-foreground active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        >
          <DragHandleIcon />
        </button>
      )}
      <h2 className="min-w-0 truncate text-sm font-semibold">{props.title}</h2>
      <div className="ml-auto flex items-center gap-2">
        {props.trailing}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${props.title}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function OrchestrationV2DebugRoute() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const [projection, setProjection] = useState<OrchestrationV2ThreadProjection | null>(null);
  const [logEntries, setLogEntries] = useState<ReadonlyArray<LogEntry>>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [visiblePanels, setVisiblePanels] =
    useState<ReadonlyArray<PanelKey>>(DEFAULT_VISIBLE_PANELS);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const hiddenPanels = useMemo(
    () => ALL_PANEL_KEYS.filter((key) => !visiblePanels.includes(key)),
    [visiblePanels],
  );

  const restorePanel = useCallback(
    (key: PanelKey, targetKey?: PanelKey, side: "before" | "after" = "before") => {
      setVisiblePanels((prev) => {
        const without = prev.filter((k) => k !== key);
        if (targetKey === undefined) return [...without, key];
        const targetIdx = without.indexOf(targetKey);
        if (targetIdx === -1) return [...without, key];
        const insertIdx = side === "before" ? targetIdx : targetIdx + 1;
        return [...without.slice(0, insertIdx), key, ...without.slice(insertIdx)];
      });
    },
    [],
  );

  const closePanel = useCallback((key: PanelKey) => {
    setVisiblePanels((prev) => prev.filter((k) => k !== key));
  }, []);

  const api = useMemo(() => getPrimaryEnvironmentConnection().client.orchestrationV2, []);
  const projectionTimeline = useMemo(() => buildProjectionTimeline(projection), [projection]);
  const streamTimeline = useMemo(() => buildStreamTimeline(logEntries), [logEntries]);
  const itemTimeline = useMemo(
    () => buildItemTimeline({ projection, logEntries }),
    [logEntries, projection],
  );
  const activeTurn = useMemo(() => deriveActiveTurn(projection), [projection]);
  const queuedRuns = useMemo(() => buildQueuedRunRows(projection), [projection]);

  const appendLog = useCallback((entry: LogEntry) => {
    setLogEntries((entries) => [...entries, entry]);
  }, []);

  const clearSubscription = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  useEffect(() => clearSubscription, [clearSubscription]);

  const refreshProjection = useCallback(
    async (nextThreadId: ThreadId) => {
      const nextProjection = await api.getThreadProjection({ threadId: nextThreadId });
      setProjection(nextProjection);
      return nextProjection;
    },
    [api],
  );

  const subscribeToThread = useCallback(
    (nextThreadId: ThreadId) => {
      clearSubscription();
      unsubscribeRef.current = api.subscribeThread(
        { threadId: nextThreadId },
        (item) => {
          appendLog({ type: "stream", value: item });
          if (item.kind === "snapshot") {
            setProjection(item.projection);
            return;
          }
          if (item.kind === "event") {
            setProjection((current) => applyStreamEventToProjection(current, item.event));
          }
        },
        {
          onResubscribe: () => {
            appendLog({
              type: "command",
              label: "subscription.resubscribe",
              value: { threadId: nextThreadId },
            });
          },
        },
      );
    },
    [api, appendLog, clearSubscription],
  );

  const ensureThread = useCallback(async () => {
    if (threadId !== null) {
      return threadId;
    }

    const nextThreadId = newThreadId();
    const result = await api.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId: nextThreadId,
      projectId: newProjectId(),
      title: "V2 debug thread",
      modelSelection: DEFAULT_MODEL_SELECTION,
      runtimeMode: "full-access" satisfies RuntimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    setThreadId(nextThreadId);
    appendLog({ type: "command", label: "thread.create", value: result });
    subscribeToThread(nextThreadId);
    await refreshProjection(nextThreadId);
    return nextThreadId;
  }, [api, appendLog, refreshProjection, subscribeToThread, threadId]);

  const sendPrompt = useCallback(
    async (intent: "send" | "steer" = "send") => {
      const trimmedPrompt = prompt.trim();
      if (trimmedPrompt.length === 0 || isBusy) {
        return;
      }

      setIsBusy(true);
      try {
        const activeThreadId = await ensureThread();
        const targetRunId = activeTurn?.targetRunId;
        const result = await api.dispatchCommand({
          type: "message.dispatch",
          commandId: newCommandId(),
          threadId: activeThreadId,
          messageId: newMessageId(),
          text: trimmedPrompt,
          attachments: [],
          modelSelection: DEFAULT_MODEL_SELECTION,
          dispatchMode:
            intent === "steer" && targetRunId !== undefined
              ? { type: "steer_active", targetRunId }
              : targetRunId !== undefined
                ? { type: "queue_after_active" }
                : { type: "start_immediately" },
        });
        appendLog({ type: "command", label: "message.dispatch", value: result });
        await refreshProjection(activeThreadId);
      } catch (error) {
        appendLog({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsBusy(false);
      }
    },
    [activeTurn?.targetRunId, api, appendLog, ensureThread, isBusy, prompt, refreshProjection],
  );

  const promoteQueuedRun = useCallback(
    async (queuedRunId: RunId) => {
      if (threadId === null || activeTurn === null || isBusy) return;
      setIsBusy(true);
      try {
        const result = await api.dispatchCommand({
          type: "queued-message.promote-to-steer",
          commandId: newCommandId(),
          threadId,
          queuedRunId,
          targetRunId: activeTurn.targetRunId,
        });
        appendLog({ type: "command", label: "queued-message.promote-to-steer", value: result });
        await refreshProjection(threadId);
      } catch (error) {
        appendLog({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsBusy(false);
      }
    },
    [activeTurn, api, appendLog, isBusy, refreshProjection, threadId],
  );

  const interruptActiveRun = useCallback(async () => {
    if (threadId === null || activeTurn === null || isBusy) return;
    setIsBusy(true);
    try {
      const result = await api.dispatchCommand({
        type: "run.interrupt",
        commandId: newCommandId(),
        threadId,
        runId: activeTurn.targetRunId,
      });
      appendLog({ type: "command", label: "run.interrupt", value: result });
      await refreshProjection(threadId);
    } catch (error) {
      appendLog({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsBusy(false);
    }
  }, [activeTurn, api, appendLog, isBusy, refreshProjection, threadId]);

  const reorderQueuedRun = useCallback(
    async (runId: RunId, beforeRunId: RunId | null) => {
      if (threadId === null || isBusy) return;
      setIsBusy(true);
      try {
        const result = await api.dispatchCommand({
          type: "queued-run.reorder",
          commandId: newCommandId(),
          threadId,
          runId,
          beforeRunId,
        });
        appendLog({ type: "command", label: "queued-run.reorder", value: result });
        await refreshProjection(threadId);
      } catch (error) {
        appendLog({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsBusy(false);
      }
    },
    [api, appendLog, isBusy, refreshProjection, threadId],
  );

  const reset = useCallback(() => {
    clearSubscription();
    setThreadId(null);
    setProjection(null);
    setLogEntries([]);
  }, [clearSubscription]);

  const renderPanel = (panelKey: PanelKey): ReactNode => {
    const onClose = () => {
      closePanel(panelKey);
    };
    switch (panelKey) {
      case "projection":
        return (
          <TimelinePanel
            title={PANEL_TITLES.projection}
            entries={projectionTimeline}
            panelKey={panelKey}
            onClose={onClose}
          />
        );
      case "item":
        return (
          <ItemTimelinePanel
            title={PANEL_TITLES.item}
            rows={itemTimeline}
            activeTurn={activeTurn}
            panelKey={panelKey}
            onClose={onClose}
          />
        );
      case "stream":
        return (
          <TimelinePanel
            title={PANEL_TITLES.stream}
            entries={streamTimeline}
            dense
            autoScroll
            panelKey={panelKey}
            onClose={onClose}
          />
        );
    }
  };

  return (
    <main className="grid h-dvh min-h-0 w-full min-w-0 max-w-full flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden bg-background p-4 text-foreground">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-5 gap-y-3 ">
        <div className="min-w-0"></div>
        <div className="flex flex-wrap items-center gap-3">
          <HiddenPanelPills hiddenPanels={hiddenPanels} onRestore={restorePanel} />
          <ThreadStatusInline
            threadId={threadId}
            provider={DEFAULT_MODEL_SELECTION.provider}
            model={DEFAULT_MODEL_SELECTION.model}
            streamCount={logEntries.length}
          />
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            onClick={reset}
          >
            Reset
          </button>
        </div>
      </header>

      <PanelHost
        visiblePanels={visiblePanels}
        hiddenPanels={hiddenPanels}
        renderPanel={renderPanel}
        onReorder={restorePanel}
        onRestoreAtEnd={(key) => {
          restorePanel(key);
        }}
      />

      <section className="min-h-0 min-w-0">
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void sendPrompt("send");
          }}
        >
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            <textarea
              name="prompt"
              aria-label="Prompt"
              className="h-24 min-h-0 resize-none rounded-md border border-border  px-3 py-2 bg-muted font-mono text-base -outline-offset-1 focus-visible:outline-2 focus-visible:outline-blue-500 sm:h-20 sm:text-sm"
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void sendPrompt("send");
                }
              }}
            />
          </label>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <kbd className="font-mono text-xs font-normal text-muted-foreground">
              {IS_MAC ? "⌘ + ↵" : "Ctrl + ↵"} to {activeTurn === null ? "send" : "queue"}
            </kbd>
            {activeTurn === null ? null : (
              <>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    void interruptActiveRun();
                  }}
                  className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-900 disabled:cursor-not-allowed disabled:opacity-50 hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                >
                  Interrupt
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    void sendPrompt("steer");
                  }}
                  className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-sky-200 bg-sky-50 px-3 text-sm font-medium text-sky-900 disabled:cursor-not-allowed disabled:opacity-50 hover:bg-sky-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                >
                  Steer
                </button>
              </>
            )}
            <button
              type="submit"
              disabled={isBusy}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md bg-foreground px-4 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            >
              {isBusy ? (
                <>
                  <span
                    aria-hidden="true"
                    className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                  />
                  Dispatching
                </>
              ) : activeTurn === null ? (
                "Send"
              ) : (
                "Queue"
              )}
            </button>
          </div>
        </form>
        <QueueControls
          rows={queuedRuns}
          activeTurn={activeTurn}
          disabled={isBusy}
          onPromote={promoteQueuedRun}
          onReorder={reorderQueuedRun}
        />
      </section>
    </main>
  );
}

function statusClass(status: string | undefined): string {
  switch (status) {
    case "queued":
      return "border-violet-200 bg-violet-50 text-violet-800";
    case "completed":
    case "received":
    case "active":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "running":
    case "streaming":
    case "sent":
      return "border-sky-200 bg-sky-50 text-sky-800";
    case "waiting":
    case "pending":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "failed":
    case "cancelled":
      return "border-red-200 bg-red-50 text-red-800";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function statusDotClass(status: string | undefined): string {
  switch (status) {
    case "queued":
      return "bg-violet-500";
    case "completed":
    case "received":
    case "active":
      return "bg-emerald-500";
    case "running":
    case "streaming":
    case "sent":
      return "bg-sky-500";
    case "waiting":
    case "pending":
      return "bg-amber-500";
    case "failed":
    case "cancelled":
      return "bg-red-500";
    default:
      return "bg-muted-foreground/40";
  }
}

function usePinnedAutoScroll(
  itemCount: number,
  resetKey: unknown,
  enabled: boolean,
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onScroll = () => {
      const threshold = 32;
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    if (itemCount === 0) {
      pinnedRef.current = true;
      return;
    }
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [itemCount, enabled, resetKey]);

  return ref;
}

function TimelineEntryRow(props: {
  readonly entry: TimelineEntry;
  readonly isLast: boolean;
  readonly dense?: boolean | undefined;
  readonly nowMs: number;
}) {
  const { entry, isLast, dense, nowMs } = props;
  return (
    <li className="grid min-w-0 grid-cols-[0.75rem_minmax(0,1fr)] gap-3">
      <div className="relative flex justify-center">
        <span
          className={`mt-1.5 size-2.5 shrink-0 rounded-full ring-2 ring-card ${statusDotClass(
            entry.status,
          )}`}
        />
        {!isLast ? <span className="absolute top-5 bottom-0 w-px bg-border" /> : null}
      </div>
      <article className="min-w-0 pb-3 text-base sm:text-sm">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {entry.eyebrow}
          </span>
          {entry.sequence === undefined ? null : (
            <span className="rounded-full border border-border px-1.5 font-mono text-xs text-muted-foreground">
              #{entry.sequence}
            </span>
          )}
          {entry.status === undefined ? null : (
            <span
              className={`rounded-full border px-1.5 text-xs font-medium ${statusClass(
                entry.status,
              )}`}
            >
              {entry.status}
            </span>
          )}
          <span className="ml-auto">
            <Timestamp iso={entry.timestamp} nowMs={nowMs} />
          </span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h3 className="min-w-0 truncate font-medium">{entry.title}</h3>
          {entry.subtitle === undefined ? null : (
            <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {entry.subtitle}
            </p>
          )}
        </div>
        {entry.body === undefined ? null : (
          <p className="mt-1.5 line-clamp-4 wrap-break-word whitespace-pre-wrap text-muted-foreground">
            {entry.body}
          </p>
        )}
        <details className="mt-1.5">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            Raw JSON
          </summary>
          <pre
            className={`mt-1.5 max-h-72 min-w-0 max-w-full overflow-auto overscroll-contain whitespace-pre rounded-md bg-muted p-2.5 font-mono text-xs ${
              dense ? "sm:max-h-96" : ""
            }`}
          >
            {JSON.stringify(entry.raw, null, 2)}
          </pre>
        </details>
      </article>
    </li>
  );
}

function TimelinePanel(props: {
  readonly title: string;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly dense?: boolean;
  readonly autoScroll?: boolean;
  readonly panelKey?: PanelKey;
  readonly onClose?: () => void;
}) {
  const nowMs = useNow();
  const entryCount = props.entries.length;
  const scrollRef = usePinnedAutoScroll(entryCount, undefined, Boolean(props.autoScroll));

  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-card shadow-sm">
      <PanelHeader
        title={props.title}
        panelKey={props.panelKey}
        onClose={props.onClose}
        trailing={
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
            {entryCount}
          </span>
        }
      />
      {entryCount === 0 ? (
        <div className="flex min-h-48 items-center justify-center p-6 text-base text-muted-foreground sm:text-sm">
          No items yet.
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto px-3 py-3 sm:px-4">
          <ol role="list">
            {props.entries.map((entry, index) => (
              <TimelineEntryRow
                key={entry.key}
                entry={entry}
                isLast={index === entryCount - 1}
                dense={props.dense}
                nowMs={nowMs}
              />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

type ItemViewMode = "chat" | "raw";

function ItemTimelinePanel(props: {
  readonly title: string;
  readonly rows: ReadonlyArray<ItemTimelineRow>;
  readonly activeTurn: ActiveTurn | null;
  readonly panelKey?: PanelKey;
  readonly onClose?: () => void;
}) {
  const [viewMode, setViewMode] = useState<ItemViewMode>("chat");
  const nowMs = useNow();
  const rowCount = props.rows.length;
  const activeTurnStartMs = props.activeTurn?.startMs ?? null;
  const scrollRef = usePinnedAutoScroll(
    rowCount,
    `${viewMode}:${activeTurnStartMs ?? "idle"}`,
    true,
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-card shadow-sm">
      <PanelHeader
        title={props.title}
        panelKey={props.panelKey}
        onClose={props.onClose}
        trailing={
          <>
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
              {rowCount}
            </span>
          </>
        }
      />
      {rowCount === 0 && activeTurnStartMs === null ? (
        <div className="flex min-h-48 items-center justify-center p-6 text-base text-muted-foreground sm:text-sm">
          No items yet.
        </div>
      ) : viewMode === "chat" ? (
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto px-3 py-3 sm:px-4">
          <ChatScenes rows={props.rows} nowMs={nowMs} activeTurn={props.activeTurn} />
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto px-3 py-3 sm:px-4">
          <ol role="list">
            {props.rows.map((row, index) => (
              <TimelineEntryRow
                key={row.entry.key}
                entry={row.entry}
                isLast={index === rowCount - 1}
                nowMs={nowMs}
              />
            ))}
          </ol>
          {activeTurnStartMs !== null ? <WorkingIndicator startMs={activeTurnStartMs} /> : null}
        </div>
      )}
    </section>
  );
}

function ViewModeToggle(props: {
  readonly value: ItemViewMode;
  readonly onChange: (next: ItemViewMode) => void;
}) {
  const options: ReadonlyArray<{ value: ItemViewMode; label: string }> = [
    { value: "chat", label: "Chat" },
    { value: "raw", label: "Raw" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Item timeline view mode"
      className="flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
    >
      {options.map((option) => {
        const active = props.value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              props.onChange(option.value);
            }}
            className={`rounded-sm px-2 py-0.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
              active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// --- Chat rendering -------------------------------------------------------

function ChatClock(props: { readonly iso: string | undefined; readonly nowMs: number }) {
  if (props.iso === undefined) return null;
  const parsed = new Date(props.iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const clock = parsed.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <time
      dateTime={props.iso}
      title={props.iso}
      className="font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground"
    >
      {clock} · {formatRelative(parsed.getTime(), props.nowMs)}
    </time>
  );
}

const CHAT_STATUS_HIDE = new Set(["completed"]);

function ChatStatusPill(props: { readonly status: OrchestrationV2TurnItemStatus }) {
  if (CHAT_STATUS_HIDE.has(props.status)) return null;
  return (
    <span className={`rounded-full border px-1.5 text-xs font-medium ${statusClass(props.status)}`}>
      {props.status}
    </span>
  );
}

function StreamingDot() {
  return (
    <span
      aria-hidden="true"
      className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-sky-500 align-middle"
    />
  );
}

type ChatScene =
  | { readonly kind: "standalone"; readonly item: OrchestrationV2TurnItem }
  | { readonly kind: "response"; readonly duration: string | undefined; readonly anchorId: string }
  | {
      readonly kind: "work-log";
      readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    };

const STANDALONE_CHAT_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "user_message",
  "assistant_message",
  "run_interrupt_request",
  "run_interrupt_result",
  "user_input_request",
  "approval_request",
]);

function itemStartMs(item: OrchestrationV2TurnItem): number | null {
  const iso = formatTimestamp(item.startedAt ?? item.updatedAt);
  if (iso === undefined) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function itemEndMs(item: OrchestrationV2TurnItem): number | null {
  const iso = formatTimestamp(item.completedAt ?? item.updatedAt ?? item.startedAt);
  if (iso === undefined) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function formatDurationShort(diffMs: number): string | undefined {
  if (diffMs < 0) return undefined;
  if (diffMs < 1000) return `${diffMs}ms`;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const restSec = sec % 60;
  if (min < 60) return restSec > 0 ? `${min}m ${restSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin > 0 ? `${hr}h ${restMin}m` : `${hr}h`;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "starting",
  "running",
  "waiting",
]);

interface ActiveTurn {
  readonly startMs: number;
  readonly runIds: ReadonlySet<RunId>;
  readonly targetRunId: RunId;
}

function deriveActiveTurn(projection: OrchestrationV2ThreadProjection | null): ActiveTurn | null {
  if (projection === null) return null;
  // The agent is only actually working when a provider thread is `active`.
  // A run can linger in `running` after the provider has gone `idle`, so the
  // run status alone isn't enough to decide — both must indicate activity.
  const hasActiveProviderThread = projection.providerThreads.some(
    (providerThread) => providerThread.status === "active",
  );
  if (!hasActiveProviderThread) return null;
  const activeRuns = projection.runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
  if (activeRuns.length === 0) return null;
  const latestActiveRun = activeRuns[activeRuns.length - 1];
  if (!latestActiveRun) return null;
  const iso = formatTimestamp(latestActiveRun.startedAt ?? latestActiveRun.requestedAt);
  if (iso === undefined) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return {
    startMs: ms,
    runIds: new Set(activeRuns.map((run) => run.id)),
    targetRunId: latestActiveRun.id,
  };
}

function buildQueuedRunRows(
  projection: OrchestrationV2ThreadProjection | null,
): ReadonlyArray<QueuedRunRow> {
  if (projection === null) return [];
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    )
    .map((run) => {
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      return {
        run,
        messageText: message?.text ?? "(message missing)",
      };
    });
}

function buildChatScenes(
  rows: ReadonlyArray<ItemTimelineRow>,
  activeRunIds: ReadonlySet<RunId>,
): ReadonlyArray<ChatScene> {
  const scenes: Array<ChatScene> = [];
  let currentLog: Array<OrchestrationV2TurnItem> = [];
  let workStartMs: number | null = null;
  let pendingResponse = false;

  const flushLog = () => {
    if (currentLog.length > 0) {
      scenes.push({ kind: "work-log", items: currentLog });
      currentLog = [];
    }
  };

  for (const row of rows) {
    const item = row.item;

    if (item.type === "user_message") {
      flushLog();
      scenes.push({ kind: "standalone", item });
      workStartMs = itemEndMs(item);
      pendingResponse = false;
      continue;
    }

    if (item.type === "assistant_message") {
      flushLog();
      // Only emit the "Response" banner once the whole turn has settled —
      // not just the individual assistant message. If the run this message
      // belongs to is still active, the turn isn't over (more work may follow)
      // and the live WorkingIndicator is what should be visible instead.
      const runStillActive = item.runId !== null && activeRunIds.has(item.runId);
      const turnSettled = !item.streaming && item.status === "completed" && !runStillActive;
      if (pendingResponse && turnSettled) {
        const assistantStart = itemStartMs(item);
        const duration =
          workStartMs !== null && assistantStart !== null
            ? formatDurationShort(assistantStart - workStartMs)
            : undefined;
        scenes.push({ kind: "response", duration, anchorId: item.id });
        pendingResponse = false;
      }
      scenes.push({ kind: "standalone", item });
      if (turnSettled) {
        workStartMs = itemEndMs(item);
      }
      continue;
    }

    if (item.type === "run_interrupt_request") {
      flushLog();
      scenes.push({ kind: "standalone", item });
      pendingResponse = false;
      continue;
    }

    if (item.type === "run_interrupt_result") {
      flushLog();
      scenes.push({ kind: "standalone", item });
      workStartMs = itemEndMs(item);
      pendingResponse = false;
      continue;
    }

    if (STANDALONE_CHAT_TYPES.has(item.type)) {
      flushLog();
      scenes.push({ kind: "standalone", item });
      pendingResponse = true;
      continue;
    }

    if (currentLog.length === 0) {
      const start = itemStartMs(item);
      if (start !== null) {
        workStartMs = start;
      }
    }
    currentLog.push(item);
    pendingResponse = true;
  }

  flushLog();
  return scenes;
}

const EMPTY_RUN_ID_SET: ReadonlySet<RunId> = new Set();

function ChatScenes(props: {
  readonly rows: ReadonlyArray<ItemTimelineRow>;
  readonly nowMs: number;
  readonly activeTurn: ActiveTurn | null;
}) {
  const activeRunIds = props.activeTurn?.runIds ?? EMPTY_RUN_ID_SET;
  const scenes = useMemo(
    () => buildChatScenes(props.rows, activeRunIds),
    [props.rows, activeRunIds],
  );
  return (
    <div className="flex flex-col gap-2">
      {scenes.map((scene, index) => {
        if (scene.kind === "standalone") {
          return <ChatItem key={`item:${scene.item.id}`} item={scene.item} nowMs={props.nowMs} />;
        }
        if (scene.kind === "response") {
          return (
            <ChatResponseDivider key={`response:${scene.anchorId}`} duration={scene.duration} />
          );
        }
        const firstId = scene.items[0]?.id ?? `idx-${index}`;
        return <ChatWorkLog key={`work:${firstId}`} items={scene.items} />;
      })}
      {props.activeTurn !== null ? <WorkingIndicator startMs={props.activeTurn.startMs} /> : null}
    </div>
  );
}

function WorkingIndicator(props: { readonly startMs: number }) {
  const nowMs = useNow(1000);
  const elapsedMs = Math.max(0, nowMs - props.startMs);
  const elapsed = formatDurationShort(elapsedMs) ?? "0s";
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 px-2 py-3 text-xs text-muted-foreground"
    >
      <span aria-hidden="true" className="flex items-center gap-1">
        <span className="size-1 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
        <span className="size-1 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
        <span className="size-1 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
      </span>
      <span className="tabular-nums">Working for {elapsed}</span>
    </div>
  );
}

function ChatResponseDivider(props: { readonly duration: string | undefined }) {
  return (
    <div
      role="separator"
      aria-label={props.duration ? `Response · worked for ${props.duration}` : "Response"}
      className="my-1 flex items-center gap-3"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border bg-background px-2.5 py-1 font-mono text-xs font-medium tracking-wide uppercase text-muted-foreground">
        Response
        {props.duration ? (
          <>
            <span aria-hidden="true" className="mx-1.5 text-muted-foreground/60">
              ·
            </span>
            Worked for {props.duration}
          </>
        ) : null}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

type WorkLogTone = "muted" | "sky" | "emerald" | "red" | "amber";

function workLogToneClass(tone: WorkLogTone): string {
  switch (tone) {
    case "sky":
      return "text-sky-600";
    case "emerald":
      return "text-emerald-600";
    case "red":
      return "text-red-600";
    case "amber":
      return "text-amber-600";
    case "muted":
      return "text-muted-foreground";
  }
}

function clipOneLine(value: string | undefined, max = 120): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

interface WorkLogRowContent {
  readonly glyph: string;
  readonly label: string;
  readonly preview?: string | undefined;
  readonly tone: WorkLogTone;
}

function workLogRowContent(item: OrchestrationV2TurnItem): WorkLogRowContent {
  switch (item.type) {
    case "reasoning":
      return {
        glyph: "◇",
        label: "Reasoning",
        preview: clipOneLine(item.text, 160),
        tone: "muted",
      };
    case "proposed_plan":
      return {
        glyph: "✓",
        label: "Plan updated",
        preview: clipOneLine(item.markdown, 160),
        tone: "emerald",
      };
    case "todo_list": {
      const completed = item.steps.filter((step) => step.status === "completed").length;
      const total = item.steps.length;
      const summary = total === 0 ? undefined : `${completed}/${total} done`;
      const preview = clipOneLine(item.explanation, 120) ?? summary;
      return {
        glyph: "✓",
        label: "Plan updated",
        preview,
        tone: "emerald",
      };
    }
    case "file_change": {
      const stats =
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} / -${item.deletions ?? 0}`;
      return {
        glyph: "±",
        label: `Edited ${item.fileName}`,
        preview: stats,
        tone: "sky",
      };
    }
    case "command_execution": {
      const failed = item.exitCode !== undefined && item.exitCode !== 0;
      return {
        glyph: ">_",
        label: "Ran command",
        preview: clipOneLine(item.input, 160),
        tone: failed ? "red" : "muted",
      };
    }
    case "file_search":
      return {
        glyph: "⌕",
        label: "File search",
        preview: clipOneLine(item.pattern, 120),
        tone: "muted",
      };
    case "web_search":
      return {
        glyph: "⊕",
        label: "Web search",
        preview: clipOneLine(item.patterns?.join(", "), 120),
        tone: "muted",
      };
    case "dynamic_tool":
      return {
        glyph: "⚙",
        label: item.toolName ?? "Tool",
        preview: clipOneLine(stringifyShort(item.input), 120),
        tone: "muted",
      };
    case "checkpoint":
      return {
        glyph: "◉",
        label: "Checkpoint",
        preview: `${item.files.length} file${item.files.length === 1 ? "" : "s"}`,
        tone: "muted",
      };
    case "run_interrupt_request":
      return {
        glyph: "!",
        label: "Interrupt requested",
        preview: item.message,
        tone: "amber",
      };
    case "run_interrupt_result":
      return {
        glyph: "!",
        label: "Run interrupted",
        preview: item.message,
        tone: "red",
      };
    case "compaction":
      return {
        glyph: "≈",
        label: "Compaction",
        preview: clipOneLine(item.summary, 120),
        tone: "muted",
      };
    case "handoff":
      return {
        glyph: "⇄",
        label: "Handoff",
        preview:
          clipOneLine(item.summary, 120) ?? `${item.fromProviders.join(", ")} → ${item.toProvider}`,
        tone: "muted",
      };
    case "fork":
      return {
        glyph: "⑂",
        label: "Fork",
        preview: `→ ${compactId(item.targetThreadId) ?? item.targetThreadId}`,
        tone: "muted",
      };
    case "user_message":
    case "assistant_message":
    case "user_input_request":
    case "approval_request":
      return {
        glyph: "•",
        label: formatLabel(item.type),
        tone: "muted",
      };
  }
}

function ChatWorkLog(props: { readonly items: ReadonlyArray<OrchestrationV2TurnItem> }) {
  const itemCount = props.items.length;
  const firstStart = props.items
    .map((item) => itemStartMs(item))
    .find((value): value is number => value !== null);
  const lastEnd = [...props.items]
    .toReversed()
    .map((item) => itemEndMs(item))
    .find((value): value is number => value !== null);
  const duration =
    firstStart !== undefined && lastEnd !== undefined
      ? formatDurationShort(lastEnd - firstStart)
      : undefined;

  return (
    <section className="rounded-lg border border-border/60 bg-background/40 px-2 py-1.5">
      <header className="flex items-center justify-between gap-2 px-1 pb-1">
        <p className="font-mono text-xs font-medium tracking-wide uppercase text-muted-foreground">
          Work log ({itemCount})
        </p>
        {duration ? (
          <p className="font-mono text-xs tabular-nums text-muted-foreground/70">{duration}</p>
        ) : null}
      </header>
      <ul role="list" className="flex flex-col">
        {props.items.map((item) => (
          <ChatWorkLogRow key={`work-row:${item.id}`} item={item} />
        ))}
      </ul>
    </section>
  );
}

function ChatWorkLogRow(props: { readonly item: OrchestrationV2TurnItem }) {
  const { item } = props;
  const { glyph, label, preview, tone } = workLogRowContent(item);
  const statusSuffix =
    item.status === "completed" || item.status === "pending" ? "" : ` [${item.status}]`;
  const fullText = preview ? `${label} — ${preview}${statusSuffix}` : `${label}${statusSuffix}`;
  const iconTone = item.status === "failed" || item.status === "cancelled" ? "red" : tone;

  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-muted/40">
      <span
        aria-hidden="true"
        className={`inline-flex w-4 shrink-0 justify-center font-mono text-xs ${workLogToneClass(
          iconTone,
        )}`}
      >
        {glyph}
      </span>
      <p className="min-w-0 flex-1 truncate leading-5" title={fullText}>
        <span className="font-medium text-foreground">{label}</span>
        {preview ? (
          <>
            <span className="text-muted-foreground/60"> — </span>
            <span className="text-muted-foreground">{preview}</span>
          </>
        ) : null}
      </p>
      {item.status === "running" ? <StreamingDot /> : null}
      {item.status === "failed" || item.status === "cancelled" ? (
        <span className="shrink-0 rounded-sm bg-red-100 px-1 py-px font-mono text-xs font-medium tracking-wide uppercase text-red-900">
          {item.status}
        </span>
      ) : null}
    </li>
  );
}

function ChatItem(props: { readonly item: OrchestrationV2TurnItem; readonly nowMs: number }) {
  const { item, nowMs } = props;
  const timestamp = formatTimestamp(item.updatedAt ?? item.completedAt ?? item.startedAt);

  switch (item.type) {
    case "user_message":
      return (
        <ChatBubbleRow side="right">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-border bg-secondary px-3.5 py-2 text-base sm:text-sm">
            <p className="wrap-break-word whitespace-pre-wrap text-foreground">{item.text}</p>
          </div>
          <ChatMeta side="right">
            <ChatStatusPill status={item.status} />
            <ChatClock iso={timestamp} nowMs={nowMs} />
          </ChatMeta>
        </ChatBubbleRow>
      );

    case "assistant_message":
      return (
        <ChatBubbleRow side="left">
          <div className="max-w-[92%] text-base text-foreground sm:text-sm">
            <p className="wrap-break-word whitespace-pre-wrap">
              {item.text || (item.streaming ? "" : "—")}
              {item.streaming ? <StreamingDot /> : null}
            </p>
          </div>
          <ChatMeta side="left">
            <ChatStatusPill status={item.status} />
            <ChatClock iso={timestamp} nowMs={nowMs} />
          </ChatMeta>
        </ChatBubbleRow>
      );

    case "reasoning":
      return (
        <ChatBubbleRow side="left">
          <details className="max-w-[92%] min-w-0 rounded-md border border-dashed border-border bg-muted/40 px-3 py-1.5 text-muted-foreground open:pb-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium tracking-wide uppercase hover:text-foreground">
              <span>Reasoning</span>
              {item.streaming ? <StreamingDot /> : null}
            </summary>
            <p className="mt-1.5 wrap-break-word whitespace-pre-wrap text-base italic sm:text-sm">
              {item.text}
            </p>
          </details>
          <ChatMeta side="left">
            <ChatStatusPill status={item.status} />
            <ChatClock iso={timestamp} nowMs={nowMs} />
          </ChatMeta>
          wrap-break-word
        </ChatBubbleRow>
      );

    case "proposed_plan":
      return (
        <ChatBubbleRow side="left">
          <section className="max-w-[92%] min-w-0 rounded-md border border-border bg-background px-3 py-2">
            <header className="flex items-center gap-2 text-xs font-medium tracking-wide uppercase text-muted-foreground">
              <ToolKindPill kind="PLAN" />
              <span>Proposed plan</span>
              {item.streaming ? <StreamingDot /> : null}
            </header>
            <p className="mt-1.5 wrap-break-word whitespace-pre-wrap font-mono text-xs text-foreground">
              {item.markdown}
            </p>
          </section>
          <ChatMeta side="left">
            <ChatStatusPill status={item.status} />
            <ChatClock iso={timestamp} nowMs={nowMs} />
          </ChatMeta>
          wrap-break-word
        </ChatBubbleRow>
      );

    case "todo_list":
      return (
        <ChatBubbleRow side="left">
          <section className="max-w-[92%] min-w-0 rounded-md border border-border bg-background px-3 py-2">
            <header className="flex items-center gap-2 text-xs font-medium tracking-wide uppercase text-muted-foreground">
              <ToolKindPill kind="TODO" />
              <span>Todo list</span>
            </header>
            {item.explanation ? (
              <p className="mt-1 wrap-break-word whitespace-pre-wrap text-base text-muted-foreground sm:text-sm">
                {item.explanation}
              </p>
            ) : null}
            <ul className="mt-1.5 flex flex-col gap-1 text-base sm:text-sm" role="list">
              {item.steps.map((step) => (
                <TodoStep key={step.id} step={step} />
              ))}
              wrap-break-word
            </ul>
          </section>
          <ChatMeta side="left">
            <ChatStatusPill status={item.status} />
            <ChatClock iso={timestamp} nowMs={nowMs} />
          </ChatMeta>
        </ChatBubbleRow>
      );

    case "user_input_request":
      return (
        <ChatBubbleRow side="left">
          <section className="max-w-[92%] min-w-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            <header className="flex items-center gap-2 text-xs font-medium tracking-wide uppercase text-amber-900/70">
              <ToolKindPill kind="ASK" tone="amber" />
              <span>Input requested</span>
            </header>
            <ul className="mt-1.5 flex flex-col gap-2 text-base sm:text-sm" role="list">
              {item.questions.map((question) => (
                <QuestionRow key={question.id} question={question} />
              ))}
            </ul>
          </section>
          <ChatMeta side="left">
            <ChatStatusPill status={item.status} />
            <ChatClock iso={timestamp} nowMs={nowMs} />
          </ChatMeta>
        </ChatBubbleRow>
      );

    case "approval_request":
      return (
        <ChatBubbleRow side="left">
          <section className="max-w-[92%] min-w-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            <header className="flex items-center gap-2 text-xs font-medium tracking-wide uppercase text-amber-900/70">
              <ToolKindPill kind="APPROVE" tone="amber" />
              <span>{formatLabel(item.requestKind)}</span>
            </header>
            {item.prompt ? (
              <p className="mt-1 wrap-break-word whitespace-pre-wrap text-base sm:text-sm">
                {item.prompt}
              </p>
            ) : null}
          </section>
          <ChatMeta side="left">
            <ChatStatusPill status={item.status} />
            <ChatClock iso={timestamp} nowMs={nowMs} />
          </ChatMeta>
        </ChatBubbleRow>
      );

    case "file_change": {
      const stats =
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} / -${item.deletions ?? 0}`;
      return (
        <ChatToolChip
          kind="EDIT"
          title={item.fileName}
          summary={stats}
          detail={item.diffStr}
          monoDetail
          status={item.status}
          timestamp={timestamp}
          nowMs={nowMs}
        />
      );
    }

    case "command_execution": {
      const firstLine = item.input.split("\n", 1)[0]?.trim() || "(empty command)";
      const failed = item.exitCode !== undefined && item.exitCode !== 0;
      const summary = item.exitCode === undefined ? undefined : `exit ${item.exitCode}`;
      return (
        <ChatToolChip
          kind="CMD"
          title={firstLine}
          summary={summary}
          detail={[item.input, item.output].filter(Boolean).join("\n\n") || undefined}
          monoDetail
          tone={failed ? "red" : undefined}
          status={item.status}
          timestamp={timestamp}
          nowMs={nowMs}
        />
      );
    }

    case "file_search": {
      const count = item.results?.length ?? 0;
      const summary =
        item.results === undefined ? undefined : `${count} result${count === 1 ? "" : "s"}`;
      const detail = item.results
        ?.map((result) =>
          [result.fileName, result.line === undefined ? undefined : `:${result.line}`].join(""),
        )
        .join("\n");
      return (
        <ChatToolChip
          kind="FIND"
          title={item.pattern ?? "File search"}
          summary={summary}
          detail={detail}
          monoDetail
          status={item.status}
          timestamp={timestamp}
          nowMs={nowMs}
        />
      );
    }

    case "web_search": {
      const count = item.results?.length ?? 0;
      const summary =
        item.results === undefined ? undefined : `${count} result${count === 1 ? "" : "s"}`;
      const detail = item.results
        ?.map((result) => result.title ?? result.url ?? result.snippet ?? "")
        .filter(Boolean)
        .join("\n");
      return (
        <ChatToolChip
          kind="WEB"
          title={item.patterns?.join(", ") || "Web search"}
          summary={summary}
          detail={detail}
          status={item.status}
          timestamp={timestamp}
          nowMs={nowMs}
        />
      );
    }

    case "dynamic_tool":
      return (
        <ChatToolChip
          kind="TOOL"
          title={item.toolName ?? "Dynamic tool"}
          detail={stringifyShort(item.output) ?? stringifyShort(item.input)}
          monoDetail
          status={item.status}
          timestamp={timestamp}
          nowMs={nowMs}
        />
      );

    case "checkpoint":
      return (
        <ChatSystemDivider
          label="Checkpoint"
          description={`${item.files.length} file${item.files.length === 1 ? "" : "s"}`}
          timestamp={timestamp}
          nowMs={nowMs}
        />
      );

    case "run_interrupt_request":
      return (
        <ChatBubbleRow side="right">
          <div className="flex max-w-[85%] items-center gap-2 text-xs text-red-700">
            <span aria-hidden="true" className="font-mono">
              ■
            </span>
            <span className="wrap-break-word font-medium">{item.message}</span>
            <ChatClock iso={timestamp} nowMs={nowMs} />
          </div>
        </ChatBubbleRow>
      );

    case "run_interrupt_result":
      return (
        <ChatSystemDivider
          label="Run interrupted"
          // description={item.message}
          timestamp={timestamp}
          nowMs={nowMs}
          tone="red"
        />
      );

    case "compaction":
      return (
        <ChatSystemDivider
          label="Compaction"
          description={item.summary}
          timestamp={timestamp}
          nowMs={nowMs}
        />
      );

    case "handoff":
      return (
        <ChatSystemDivider
          label="Handoff"
          description={item.summary ?? `${item.fromProviders.join(", ")} → ${item.toProvider}`}
          timestamp={timestamp}
          nowMs={nowMs}
        />
      );

    case "fork":
      return (
        <ChatSystemDivider
          label="Fork"
          description={`→ ${compactId(item.targetThreadId) ?? item.targetThreadId}`}
          timestamp={timestamp}
          nowMs={nowMs}
        />
      );
  }
}

function ChatBubbleRow(props: { readonly side: "left" | "right"; readonly children: ReactNode }) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-0.5 ${
        props.side === "right" ? "items-end" : "items-start"
      }`}
    >
      {props.children}
    </div>
  );
}

function ChatMeta(props: { readonly side: "left" | "right"; readonly children: ReactNode }) {
  return (
    <div
      className={`flex items-center gap-1.5 text-xs ${
        props.side === "right" ? "flex-row-reverse" : ""
      }`}
    >
      {props.children}
    </div>
  );
}

type ToolChipTone = "neutral" | "red";
type ToolKindPillTone = "neutral" | "red" | "amber";

function ChatToolChip(props: {
  readonly kind: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly detail?: string | undefined;
  readonly monoDetail?: boolean | undefined;
  readonly tone?: ToolChipTone | undefined;
  readonly status: OrchestrationV2TurnItemStatus;
  readonly timestamp: string | undefined;
  readonly nowMs: number;
}) {
  const hasDetail = typeof props.detail === "string" && props.detail.length > 0;
  const toneClasses =
    props.tone === "red"
      ? "border-red-200 bg-red-50 text-red-900 hover:bg-red-100"
      : "border-border bg-background hover:bg-muted";

  return (
    <ChatBubbleRow side="left">
      <details className="min-w-0 max-w-full group/tool">
        <summary
          className={`flex min-w-0 max-w-full cursor-pointer list-none items-center gap-2 rounded-md border px-2 py-1 text-xs ${toneClasses}`}
        >
          <ToolKindPill kind={props.kind} tone={props.tone} />
          <span className="min-w-0 truncate font-medium text-foreground">{props.title}</span>
          {props.summary ? (
            <span className="min-w-0 truncate text-muted-foreground">· {props.summary}</span>
          ) : null}
          {hasDetail ? (
            <span
              aria-hidden="true"
              className="ml-auto shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90"
            >
              ›
            </span>
          ) : null}
        </summary>
        {hasDetail ? (
          <pre
            className={`mt-1 max-h-60 min-w-0 max-w-full overflow-auto overscroll-contain rounded-md bg-muted p-2 text-xs ${
              props.monoDetail ? "font-mono whitespace-pre" : "whitespace-pre-wrap"
            }`}
          >
            {props.detail}
          </pre>
        ) : null}
      </details>
      <ChatMeta side="left">
        <ChatStatusPill status={props.status} />
        <ChatClock iso={props.timestamp} nowMs={props.nowMs} />
      </ChatMeta>
    </ChatBubbleRow>
  );
}

function ToolKindPill(props: {
  readonly kind: string;
  readonly tone?: ToolKindPillTone | undefined;
}) {
  const toneClass =
    props.tone === "red"
      ? "bg-red-100 text-red-900"
      : props.tone === "amber"
        ? "bg-amber-100 text-amber-900"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={`shrink-0 rounded-sm px-1 py-px font-mono text-xs font-medium tracking-wide uppercase ${toneClass}`}
    >
      {props.kind}
    </span>
  );
}

function ChatSystemDivider(props: {
  readonly label: string;
  readonly description?: string | undefined;
  readonly timestamp: string | undefined;
  readonly nowMs: number;
  readonly tone?: "neutral" | "red" | undefined;
}) {
  const toneClass =
    props.tone === "red"
      ? "text-red-700 [&_[data-divider-line]]:bg-red-200 [&_[data-divider-pill]]:border-red-200 [&_[data-divider-pill]]:bg-red-50 [&_[data-divider-pill]]:text-red-800"
      : "text-muted-foreground [&_[data-divider-line]]:bg-border";
  return (
    <div
      aria-label={props.label}
      className={`flex min-w-0 items-center gap-2 py-1 text-xs ${toneClass}`}
    >
      <span data-divider-line aria-hidden="true" className="h-px flex-1" />
      <span
        data-divider-pill
        className="shrink-0 rounded-full border border-transparent px-2 py-0.5 font-mono font-medium tracking-wide uppercase"
      >
        {props.label}
      </span>
      {props.description ? (
        <span className="min-w-0 max-w-[60%] truncate">{props.description}</span>
      ) : null}
      <ChatClock iso={props.timestamp} nowMs={props.nowMs} />
      <span data-divider-line aria-hidden="true" className="h-px flex-1" />
    </div>
  );
}

function TodoStep(props: { readonly step: OrchestrationV2PlanStep }) {
  const { step } = props;
  const symbol = step.status === "completed" ? "✓" : step.status === "running" ? "◐" : "○";
  const symbolClass =
    step.status === "completed"
      ? "text-emerald-600"
      : step.status === "running"
        ? "text-sky-600"
        : "text-muted-foreground";
  const textClass = step.status === "completed" ? "line-through text-muted-foreground" : "";
  return (
    <li className="flex min-w-0 items-baseline gap-2">
      <span aria-hidden="true" className={`font-mono text-xs ${symbolClass}`}>
        {symbol}
      </span>
      <span className={`min-w-0 wrap-break-word ${textClass}`}>{step.text}</span>
    </li>
  );
}

function QuestionRow(props: { readonly question: OrchestrationV2UserInputQuestion }) {
  const { question } = props;
  return (
    <li className="min-w-0">
      <p className="font-medium wrap-break-word">{question.question}</p>
      {question.options.length === 0 ? null : (
        <ul className="mt-1 flex flex-wrap gap-1" role="list">
          {question.options.map((option) => (
            <li key={option.label}>
              <span className="rounded-full border border-amber-200 bg-amber-100/60 px-2 py-0.5 text-xs">
                {option.label}
              </span>
              wrap-break-word
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
