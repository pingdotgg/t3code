import {
  type GuestRun,
  type GuestShareView,
  type GuestStreamEvent,
  type GuestThreadModel,
  type GuestTurnItem,
  type GuestTurnItemDetail,
  type OrchestrationV2AppThread,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  orchestrationV2RunWorkStartedAt,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  LIVE_LINES,
  type TerminalOutputState,
} from "@t3tools/shared/terminalOutput";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";

import {
  projectTurnItemForDetail,
  projectTurnItemForWire,
} from "../orchestration-v2/WireProjection.ts";

/**
 * The guest sees the thread as the owner sees it: what ran and how it ended, and a command's
 * output once its row is expanded. Never diffs, reasoning, tool payloads, or anything that points
 * at another thread. Every guest object is built by picking fields, so a field added to a domain
 * type stays on the server until someone adds it here. The guest schemas back this up when they
 * encode.
 */

/**
 * Absolute directories a guest never sees spelled out, longest first: a workspace becomes `.`
 * and the owner's home folder becomes `~`.
 */
export type GuestPathRoots = ReadonlyArray<{ readonly dir: string; readonly as: "." | "~" }>;

export function guestPathRoots(
  workspaces: ReadonlyArray<string | null | undefined>,
  home?: string | null,
): GuestPathRoots {
  const dir = (root: string | null | undefined) => {
    const trimmed = root?.replace(/[\\/]+$/u, "");
    // A filesystem root would turn every path relative, so it is never a root here.
    return trimmed && /[^\\/:]/u.test(trimmed.replace(/^[A-Za-z]:/u, "")) ? trimmed : null;
  };
  return [
    ...workspaces.flatMap((root) => {
      const trimmed = dir(root);
      return trimmed === null ? [] : [{ dir: trimmed, as: "." as const }];
    }),
    ...[dir(home)].flatMap((trimmed) =>
      trimmed === null ? [] : [{ dir: trimmed, as: "~" as const }],
    ),
  ].toSorted((left, right) => right.dir.length - left.dir.length);
}

const isAbsolutePath = (path: string) => /^(?:[\\/]|[A-Za-z]:[\\/])/u.test(path);

/** A path inside a root loses it; any other absolute path keeps only its base name. */
function guestPath(path: string, roots: GuestPathRoots): string {
  for (const { dir, as } of roots) {
    if (path === dir) return as;
    if (path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`)) {
      const rest = path.slice(dir.length + 1);
      return as === "." ? rest || "." : `~/${rest}`;
    }
  }
  return isAbsolutePath(path) ? (path.split(/[\\/]/u).findLast(Boolean) ?? ".") : path;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Rewrites the roots inside free text, such as a command or a search query. */
function guestText(text: string, roots: GuestPathRoots): string {
  let result = text;
  for (const { dir, as } of roots) {
    if (!result.includes(dir)) continue;
    // The root itself, or the root plus a separator, but not a sibling such as `<root>-old`.
    result = result.replace(
      new RegExp(`${escapeRegExp(dir)}(?:[\\\\/]|(?![\\w.-]))`, "gu"),
      // `<root>/src` becomes `src` (or `~/src`); the root alone, or with only a trailing
      // separator, is `.` (or `~`).
      (match, offset: number, source: string) => {
        const rest = source.slice(offset + match.length);
        const continues = match.length > dir.length && rest !== "" && !/^[\s"'`]/u.test(rest);
        return continues ? (as === "." ? "" : "~/") : as;
      },
    );
  }
  return result;
}

function guestBase(
  item: OrchestrationV2TurnItem,
  runId: NonNullable<OrchestrationV2TurnItem["runId"]>,
) {
  return {
    id: item.id,
    threadId: item.threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: item.parentItemId,
    ordinal: item.ordinal,
    status: item.status,
    title: null,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    updatedAt: item.updatedAt,
  } as const;
}

type Projector<T extends OrchestrationV2TurnItem["type"]> = (
  item: Extract<OrchestrationV2TurnItem, { readonly type: T }>,
  base: ReturnType<typeof guestBase>,
  roots: GuestPathRoots,
) => GuestTurnItem | null;

const drop = () => null;

/**
 * One policy per item type. A new type fails to compile here until someone decides what a guest
 * sees of it.
 */
const GUEST_PROJECTORS: { readonly [T in OrchestrationV2TurnItem["type"]]: Projector<T> } = {
  user_message: (item, base) => {
    // Scheduled, cross-thread, agent-sent, and workflow messages can carry webhook bodies, other
    // threads' results, or scripts, so only messages a person typed into this thread pass.
    if (
      item.createdBy !== "user" ||
      item.scheduledTaskId !== undefined ||
      item.senderThreadId !== undefined ||
      item.workflowScript === true
    ) {
      return null;
    }
    const guest = item.context?.guest;
    return {
      ...base,
      type: "user_message",
      createdBy: item.createdBy,
      creationSource: item.creationSource,
      messageId: item.messageId,
      inputIntent: item.inputIntent,
      text: item.text,
      ...(guest === undefined
        ? {}
        : {
            context: {
              version: 1,
              guest: { guestMessageId: guest.guestMessageId, name: guest.name, text: guest.text },
              records: [],
            },
          }),
      attachments: [],
    };
  },
  assistant_message: (item, base) => ({
    ...base,
    type: "assistant_message",
    messageId: item.messageId,
    text: item.text,
    streaming: item.streaming,
  }),
  // The text can quote anything the agent read, and a reasoning row without text is hidden in
  // the timeline, as the owner's empty ones are. The live Thinking row comes from the run state.
  reasoning: drop,
  proposed_plan: (item, base) => ({
    ...base,
    type: "proposed_plan",
    planId: item.planId,
    markdown: item.markdown,
    streaming: item.streaming,
  }),
  user_input_request: (item, base) => ({
    ...base,
    type: "user_input_request",
    requestId: item.requestId,
    questions: item.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    })),
  }),
  file_change: (item, base, roots) => ({
    ...base,
    type: "file_change",
    fileName: guestPath(item.fileName, roots),
    ...(item.additions === undefined ? {} : { additions: item.additions }),
    ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
    ...(item.changes === undefined
      ? {}
      : {
          changes: item.changes.map((change) => ({
            operation: change.operation,
            path: guestPath(change.path, roots),
            ...(change.oldPath === undefined ? {} : { oldPath: guestPath(change.oldPath, roots) }),
          })),
        }),
  }),
  // Output stays off the stream; an expanded row fetches it, as the owner's does.
  command_execution: (item, base, roots) => ({
    ...base,
    type: "command_execution",
    input: guestText(item.input, roots),
    ...(item.outputIndicatesFailure === undefined
      ? {}
      : { outputIndicatesFailure: item.outputIndicatesFailure }),
    ...(item.outputOmitted === undefined ? {} : { outputOmitted: item.outputOmitted }),
    ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
  }),
  file_search: (item, base, roots) => ({
    ...base,
    type: "file_search",
    ...(item.pattern === undefined ? {} : { pattern: guestText(item.pattern, roots) }),
    ...(item.results === undefined
      ? {}
      : {
          results: item.results.map((result) => ({
            fileName: guestPath(result.fileName, roots),
            ...(result.line === undefined ? {} : { line: result.line }),
            ...(result.column === undefined ? {} : { column: result.column }),
          })),
        }),
  }),
  web_search: (item, base, roots) => ({
    ...base,
    type: "web_search",
    ...(item.patterns === undefined
      ? {}
      : { patterns: item.patterns.map((pattern) => guestText(pattern, roots)) }),
    ...(item.results === undefined
      ? {}
      : {
          results: item.results.map((result) => ({
            ...(result.title === undefined ? {} : { title: result.title }),
            ...(result.url === undefined ? {} : { url: result.url }),
          })),
        }),
  }),
  approval_request: (item, base) => ({
    ...base,
    type: "approval_request",
    requestId: item.requestId,
    requestKind: item.requestKind,
  }),
  run_interrupt_request: (item, base, roots) => ({
    ...base,
    type: item.type,
    message: guestText(item.message, roots),
  }),
  run_interrupt_result: (item, base, roots) => ({
    ...base,
    type: item.type,
    message: guestText(item.message, roots),
  }),
  system_notice: (item, base, roots) => ({
    ...base,
    type: item.type,
    message: guestText(item.message, roots),
  }),
  error: (item, base, roots) => ({
    ...base,
    type: "error",
    failure: {
      class: item.failure.class,
      message: guestText(item.failure.message, roots),
      code: item.failure.code,
      retryable: item.failure.retryable,
      ...(item.failure.resetAt === undefined ? {} : { resetAt: item.failure.resetAt }),
    },
    ...(item.retry === undefined
      ? {}
      : {
          retry: {
            attempt: item.retry.attempt,
            maxAttempts: item.retry.maxAttempts,
            retryDelayMs: item.retry.retryDelayMs,
          },
        }),
  }),
  compaction: (item, base) => ({
    ...base,
    type: "compaction",
    driver: item.driver,
    ...(item.beforeTokenCount === undefined ? {} : { beforeTokenCount: item.beforeTokenCount }),
    ...(item.afterTokenCount === undefined ? {} : { afterTokenCount: item.afterTokenCount }),
  }),
  subagent: (item, base) => ({
    ...base,
    type: "subagent",
    subagentId: item.subagentId,
    origin: item.origin,
    driver: item.driver,
    providerInstanceId: item.providerInstanceId,
    childThreadId: null,
    prompt: "",
    result: null,
  }),
  // Input and output can hold anything. A published visual keeps its reference, which the guest
  // loads through the render route; an MCP app keeps nothing, so its frame never mounts.
  dynamic_tool: (item, base) => {
    const htmlRender = item.status === "completed" ? htmlRenderFromToolItem(item) : undefined;
    return {
      ...base,
      type: "dynamic_tool",
      toolName: item.toolName,
      input: null,
      ...(htmlRender === undefined
        ? {}
        : {
            output: {
              htmlRender: {
                attachmentId: htmlRender.attachmentId,
                title: htmlRender.title,
                height: htmlRender.height,
                ...(htmlRender.heights === undefined ? {} : { heights: htmlRender.heights }),
              },
            },
          }),
    };
  },
  // Not timeline rows.
  todo_list: drop,
  checkpoint: drop,
  // These point at other threads, other providers' sessions, or the owner's secret prompt.
  notification: drop,
  handoff: drop,
  fork: drop,
  thread_created: drop,
  secret_request: drop,
};

/**
 * What a guest sees of one item, or null when it sees nothing. Items outside a run are dropped:
 * they cannot be placed against the share's history window.
 */
export function projectTurnItemForGuest(
  item: OrchestrationV2TurnItem,
  roots: GuestPathRoots,
): GuestTurnItem | null {
  const runId = item.runId;
  // Older clients and servers can store types this build does not know.
  const project = Object.hasOwn(GUEST_PROJECTORS, item.type)
    ? (GUEST_PROJECTORS[item.type] as Projector<typeof item.type>)
    : undefined;
  if (runId === null || project === undefined) return null;
  const wire = projectTurnItemForWire(item);
  return project(wire, guestBase(wire, runId), roots);
}

/**
 * What a guest's expanded row shows of one item: the stream's item, plus a command's output, as
 * the owner's detail fetch adds it. Every other type has nothing more for a guest.
 */
export function projectTurnItemForGuestDetail(
  item: OrchestrationV2TurnItem,
  roots: GuestPathRoots,
): GuestTurnItemDetail | null {
  const guest = projectTurnItemForGuest(item, roots);
  if (guest?.type !== "command_execution" || item.type !== "command_execution") return guest;
  const detail = projectTurnItemForDetail(item);
  return detail.type !== "command_execution" || detail.output === undefined
    ? guest
    : {
        ...guest,
        output: guestText(
          displayedOutput(
            // The detail is already bounded; the tail must not cut it again.
            appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, detail.output, Number.MAX_SAFE_INTEGER),
          ),
          roots,
        ),
      };
}

// The shared terminal model leaves only canonical SGR (colour) codes in its text.
const SGR = /\u001b\[[0-9;]*m/gu;

/**
 * Command output as a guest's timeline would display it: run through the same terminal model the
 * owner's client uses, so backspaces, carriage returns, cursor moves, and escapes are already
 * applied, then plain text. A path rewrite on raw bytes could be undone by any of those.
 */
function displayedOutput(state: TerminalOutputState): string {
  return state.text.replace(SGR, "");
}

/**
 * The length of the end of `text` that could still grow into a root and what follows it, so it is
 * rewritten whole: the root alone could be a sibling such as `<root>-old`.
 */
function rootPrefixAtEnd(text: string, roots: GuestPathRoots): number {
  let longest = 0;
  for (const { dir } of roots) {
    for (const candidate of [`${dir}/`, `${dir}\\`]) {
      for (let length = Math.min(candidate.length, text.length); length > longest; length -= 1) {
        if (text.endsWith(candidate.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
  }
  return longest;
}

const commonPrefixLength = (left: string, right: string) => {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
};

const countLines = (text: string) => {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
};

/**
 * The text that turns what the guest's client shows (`previous`) into `shown` through the same
 * terminal model, or null when only a replace can. Plain growth is appended as is. A change in
 * the last lines, such as a progress bar, moves the cursor up to the first changed line, erases
 * from there, and writes the rest. Anything else, such as a tail that dropped lines from the front
 * or a cleared screen, is a replace: guessing which lines the client may keep is how stale text
 * survived an erase.
 */
function guestOutputDelta(previous: string, shown: string): string | null {
  const common = commonPrefixLength(previous, shown);
  if (common === previous.length) return shown.slice(common);
  if (common === 0) return null;
  const lineStart = previous.lastIndexOf("\n", common - 1) + 1;
  const below = countLines(previous.slice(lineStart));
  return below < LIVE_LINES
    ? `${below > 0 ? `\u001b[${below}A` : ""}\r\u001b[J${shown.slice(lineStart)}`
    : null;
}

/**
 * Rewrites live command output frames for a guest. The server keeps the terminal state the
 * guest's client would build from the owner's frames, rewrites paths in what it displays, and
 * sends the smallest frame that brings the guest's client to exactly that text. Text at the end
 * that could still grow into a root waits for the next frame. A settled frame holds nothing back.
 * A long log's tail drops lines on nearly every frame, which needs a replace; the guest's route
 * caps the bytes per second, and the owner's stream coalesces while it waits.
 */
export function guestCommandOutputFrames(roots: GuestPathRoots) {
  let terminal = EMPTY_TERMINAL_OUTPUT;
  // The guest's client, built the way it builds itself from frames. A candidate frame is sent
  // only if this mirror then shows exactly what the server shows; the terminal model has state
  // (its live window, fixed lines) that the text alone does not reveal.
  let client: TerminalOutputState | null = null;
  const applied = (base: TerminalOutputState, truncated: boolean, text: string) =>
    appendTerminalOutput({ ...base, truncated: base.truncated || truncated }, text);
  return (frame: OrchestrationV2CommandOutputFrame): OrchestrationV2CommandOutputFrame | null => {
    terminal = appendTerminalOutput(
      frame.kind === "replace" ? EMPTY_TERMINAL_OUTPUT : terminal,
      frame.text,
    );
    const plain = displayedOutput(terminal);
    const shown = guestText(
      plain.slice(0, plain.length - (frame.running ? rootPrefixAtEnd(plain, roots) : 0)),
      roots,
    );
    const truncated = terminal.truncated || frame.truncated;
    const delta = client === null ? null : guestOutputDelta(client.text, shown);
    const next = delta === null || client === null ? null : applied(client, truncated, delta);
    if (next === null || next.text !== shown) {
      client = applied(EMPTY_TERMINAL_OUTPUT, truncated, shown);
      return { kind: "replace", text: shown, truncated, running: frame.running };
    }
    const unchanged = delta === "" && next.truncated === client!.truncated;
    client = next;
    // Nothing new to show still reports output that scrolled out, or the command settling.
    return unchanged && frame.running
      ? null
      : { kind: "append", text: delta!, truncated, running: frame.running };
  };
}

type GuestProviderTurn = Pick<
  OrchestrationV2ThreadProjection["providerTurns"][number],
  "runAttemptId" | "ordinal" | "status"
>;

const ACTIVITY_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * Whether the provider finished the run's current turn, as the owner's run summary reports it,
 * so the guest's timeline stops showing Thinking while the checkpoint is captured.
 */
export function guestRunTurnEnded(
  run: Pick<OrchestrationV2Run, "status" | "activeAttemptId">,
  providerTurns: Iterable<GuestProviderTurn>,
): boolean {
  if (!ACTIVITY_RUN_STATUSES.has(run.status) || run.activeAttemptId === null) return false;
  let latest: GuestProviderTurn | null = null;
  for (const turn of providerTurns) {
    if (
      turn.runAttemptId === run.activeAttemptId &&
      (latest === null || turn.ordinal > latest.ordinal)
    ) {
      latest = turn;
    }
  }
  return latest !== null && latest.status !== "pending" && latest.status !== "running";
}

export function projectRunForGuest(run: OrchestrationV2Run, turnEnded: boolean): GuestRun {
  return {
    id: run.id,
    ordinal: run.ordinal,
    status: run.status,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    workStartedAt: DateTime.formatIso(orchestrationV2RunWorkStartedAt(run)),
    turnEnded,
  };
}

export const isGuestVisibleRun = (
  run: Pick<OrchestrationV2Run, "ordinal">,
  historyStartRunOrdinal: number,
) => run.ordinal >= historyStartRunOrdinal;

/**
 * The runs and items a guest's snapshot starts from: runs from the share's history window on,
 * and this thread's own items in them. Rows inherited from a fork source belong to another
 * thread.
 */
export function projectSnapshotForGuest(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "visibleTurnItems" | "providerTurns">,
  historyStartRunOrdinal: number,
  roots: GuestPathRoots,
): { readonly runs: ReadonlyArray<GuestRun>; readonly items: ReadonlyArray<GuestTurnItem> } {
  const runs = projection.runs.filter((run) => isGuestVisibleRun(run, historyStartRunOrdinal));
  const runIds = new Set(runs.map((run) => run.id));
  const items = projection.visibleTurnItems.flatMap((entry) => {
    if (entry.visibility !== "local" || entry.item.runId === null) return [];
    if (!runIds.has(entry.item.runId)) return [];
    const item = projectTurnItemForGuest(entry.item, roots);
    return item === null ? [] : [item];
  });
  return {
    runs: runs.map((run) =>
      projectRunForGuest(run, guestRunTurnEnded(run, projection.providerTurns)),
    ),
    items,
  };
}

/** The thread's model as the owner's composer labels it, from the configured providers. */
export function guestThreadModel(
  selection: OrchestrationV2AppThread["modelSelection"],
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "models">>,
): GuestThreadModel {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  return {
    driver: provider?.driver ?? null,
    name: model?.name ?? selection.model,
    ...(model?.shortName === undefined ? {} : { shortName: model.shortName }),
    ...(model?.subProvider === undefined ? {} : { subProvider: model.subProvider }),
  };
}

export function guestShareView(
  thread: OrchestrationV2AppThread,
  model: GuestThreadModel,
): GuestShareView | null {
  const share = thread.guestShare;
  if (!share || share.guestName === null) return null;
  return {
    shareId: share.id,
    title: thread.title,
    guestName: share.guestName,
    expiresAt: share.expiresAt,
    messages: share.messages,
    model,
  };
}

/**
 * Keeps the last `item`, `run`, and `view` per id in a batch, at the place the first one held,
 * so a streaming reply sends one update per window and new items still arrive in order.
 */
export function coalesceGuestEvents(
  events: ReadonlyArray<GuestStreamEvent>,
): ReadonlyArray<GuestStreamEvent> {
  const slots = new Map<string, number>();
  const result: GuestStreamEvent[] = [];
  for (const event of events) {
    const key =
      event.type === "item"
        ? `item:${event.item.id}`
        : event.type === "run"
          ? `run:${event.run.id}`
          : event.type === "view"
            ? "view"
            : null;
    const slot = key === null ? undefined : slots.get(key);
    if (slot !== undefined) {
      result[slot] = event;
      continue;
    }
    if (key !== null) slots.set(key, result.length);
    result.push(event);
    if (event.type === "ended") break;
  }
  return result;
}
