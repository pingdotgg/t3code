import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { redactSecrets } from "@t3tools/shared/secretRedaction";

type TurnItem = ThreadStructure["turnItems"][number];

export type AgentEyesKind =
  | "edit"
  | "command"
  | "test"
  | "browser"
  | "game"
  | "search"
  | "memory"
  | "tool";
export type AgentEyesDetail = "summary" | "standard" | "full";

/** One thing the agent did, ready to show. Every string here has had secrets redacted. */
export interface AgentEyesEvent {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: AgentEyesKind;
  /** Short label, such as the file name or the command. */
  readonly title: string;
  readonly status: "running" | "done" | "failed";
  /** What happened, from the item itself. Never inferred. */
  readonly summary: string;
  /** The agent's own most recent message before this action, if it wrote one. */
  readonly agentSaid: string | null;
  /** The body the stage shows: a diff, command output, search results, or tool input. */
  readonly body: string;
  readonly at: string | null;
  readonly captureId?: string;
}

export const AGENT_EYES_KIND_LABELS: Record<AgentEyesKind, string> = {
  edit: "Edits",
  command: "Commands",
  test: "Tests",
  browser: "Browser",
  game: "Game Development",
  search: "Search",
  memory: "Memory",
  tool: "Tools",
};

const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:pytest|jest|vitest|mocha|rspec|phpunit|ctest|(?:vp|npm|pnpm|yarn|bun)\s+(?:run\s+)?test|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\w*\s+test|python3?\s+-m\s+(?:pytest|unittest))\b/;
const BROWSER_TOOL = /browser|navigate|screenshot|preview|playwright|click|page/i;
const MAX_BODY_CHARS = 60_000;

const clean = (text: string) => redactSecrets(text).text;

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const match = /^(.{1,280}?[.!?])(?:\s|$)/.exec(trimmed);
  return match ? match[1]! : trimmed.slice(0, 280);
}

function statusOf(item: TurnItem, failed: boolean): AgentEyesEvent["status"] {
  if (item.status === "failed" || failed) return "failed";
  return item.completedAt === null && item.status !== "completed" ? "running" : "done";
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function fileChangeBody(item: Extract<TurnItem, { type: "file_change" }>): string {
  if (item.diffStr) return item.diffStr;
  if (item.oldStr !== undefined || item.newStr !== undefined) {
    const removed = (item.oldStr ?? "").split("\n").map((line) => `-${line}`);
    const added = (item.newStr ?? "").split("\n").map((line) => `+${line}`);
    return [...(item.oldStr ? removed : []), ...(item.newStr ? added : [])].join("\n");
  }
  return "";
}

/** Turns a thread's items into the actions Agent Eyes follows, oldest first. */
export function deriveAgentEyesEvents(
  items: ReadonlyArray<TurnItem>,
  /** Message text by id; the quiet thread keeps message text apart from its items. */
  messageText: (messageId: string) => string | undefined = () => undefined,
): ReadonlyArray<AgentEyesEvent> {
  const events: AgentEyesEvent[] = [];
  let lastAgentMessage: string | null = null;
  const sorted = [...items].sort((left, right) => left.ordinal - right.ordinal);
  for (const item of sorted) {
    const at = item.startedAt === null ? null : String(item.startedAt);
    const base = { id: item.id, ordinal: item.ordinal, at, agentSaid: lastAgentMessage };
    switch (item.type) {
      case "assistant_message": {
        const inline: unknown = "text" in item ? item.text : undefined;
        const text = typeof inline === "string" ? inline : (messageText(item.messageId) ?? "");
        if (text.trim() !== "") lastAgentMessage = clean(firstSentence(text));
        continue;
      }
      case "user_message": {
        lastAgentMessage = null;
        continue;
      }
      case "file_change": {
        const counts =
          item.additions !== undefined || item.deletions !== undefined
            ? ` (+${item.additions ?? 0} −${item.deletions ?? 0})`
            : "";
        events.push({
          ...base,
          kind: "edit",
          title: item.fileName,
          status: statusOf(item, false),
          summary: `Changed ${item.fileName}${counts}.`,
          body: clean(fileChangeBody(item)).slice(0, MAX_BODY_CHARS),
        });
        continue;
      }
      case "command_execution": {
        const command = clean(item.input.trim());
        const failed = item.outputIndicatesFailure === true || (item.exitCode ?? 0) !== 0;
        const ended =
          item.exitCode === undefined
            ? item.completedAt === null
              ? "is running"
              : "finished"
            : `exited with code ${item.exitCode}`;
        const output = item.outputOmitted
          ? "(Output is not loaded here. Open the thread to see it.)"
          : clean(item.output ?? "");
        events.push({
          ...base,
          kind: TEST_COMMAND.test(item.input) ? "test" : "command",
          title: command.split("\n")[0]!.slice(0, 120),
          status: statusOf(item, failed),
          summary: `Ran \`${command.split("\n")[0]!.slice(0, 200)}\`, which ${ended}.`,
          body: `$ ${command}\n${output}`.slice(-MAX_BODY_CHARS),
        });
        continue;
      }
      case "file_search": {
        const found = item.results?.length ?? 0;
        events.push({
          ...base,
          kind: "search",
          title: item.pattern ? clean(item.pattern) : "File search",
          status: statusOf(item, false),
          summary: `Searched files${item.pattern ? ` for "${clean(item.pattern)}"` : ""} and found ${found} result${found === 1 ? "" : "s"}.`,
          body: clean(
            (item.results ?? [])
              .map(
                (result) =>
                  `${result.fileName}${result.line ? `:${result.line}` : ""}  ${result.preview ?? ""}`,
              )
              .join("\n"),
          ),
        });
        continue;
      }
      case "web_search": {
        const patterns = (item.patterns ?? []).map(clean);
        events.push({
          ...base,
          kind: "search",
          title: patterns[0] ?? "Web search",
          status: statusOf(item, false),
          summary: `Searched the web${patterns.length ? ` for "${patterns.join('", "')}"` : ""}.`,
          body: clean(
            (item.results ?? [])
              .map((result) => `${result.title}\n${result.url ?? ""}`)
              .join("\n\n"),
          ),
        });
        continue;
      }
      case "dynamic_tool": {
        // MCP tools arrive as `mcp__<server>__<tool>`; the tool name is what people recognize.
        const name = (item.toolName ?? item.title ?? "Tool").replace(
          /^mcp__[^_]+(?:_[^_]+)*?__/,
          "",
        );
        const browser =
          item.toolSurface === "browser" ||
          item.toolSource?.kind === "browser" ||
          BROWSER_TOOL.test(name);
        const game = /(?:^|__)continuum_(?:game|asset)_/.test(name);
        const memory = name.includes("continuum_memory");
        const output = item.outputOmitted ? "(Output is not loaded here.)" : stringify(item.output);
        const captureId = game
          ? /captureId\\?"\s*:\s*\\?"(cap_[a-z0-9-]+)\\?"/i.exec(output)?.[1]
          : undefined;
        events.push({
          ...base,
          kind: game ? "game" : memory ? "memory" : browser ? "browser" : "tool",
          ...(captureId === undefined ? {} : { captureId }),
          title: name,
          status: statusOf(item, false),
          summary: memory
            ? `Used project memory (${name.replace("continuum_memory_", "")}).`
            : `Used ${browser ? "the browser tool" : "the tool"} ${name}.`,
          body: clean(`${stringify(item.input)}${output ? `\n\n${output}` : ""}`).slice(
            0,
            MAX_BODY_CHARS,
          ),
        });
        continue;
      }
      default:
        continue;
    }
  }
  return events;
}

export function filterAgentEyesEvents(
  events: ReadonlyArray<AgentEyesEvent>,
  input: { readonly kinds: ReadonlySet<AgentEyesKind>; readonly query: string },
): ReadonlyArray<AgentEyesEvent> {
  const query = input.query.trim().toLowerCase();
  return events.filter(
    (event) =>
      (input.kinds.size === 0 || input.kinds.has(event.kind)) &&
      (query === "" ||
        event.title.toLowerCase().includes(query) ||
        event.summary.toLowerCase().includes(query) ||
        event.body.toLowerCase().includes(query)),
  );
}

/** How much of a body the stage shows at each detail level. */
export function bodyForDetail(body: string, detail: AgentEyesDetail): string {
  if (detail === "full") return body;
  const lines = body.split("\n");
  const limit = detail === "summary" ? 12 : 80;
  return lines.length <= limit
    ? body
    : `${lines.slice(0, limit).join("\n")}\n… ${lines.length - limit} more lines (detail: Full shows all)`;
}

export type AgentEyesMode = "live" | "paused" | "replay";
export interface AgentEyesPlayback {
  readonly mode: AgentEyesMode;
  /** The event the stage shows while paused or replaying. */
  readonly eventId: string | null;
}

export type AgentEyesAction =
  | { readonly type: "pause"; readonly eventId: string | null }
  | { readonly type: "follow" }
  | { readonly type: "select"; readonly eventId: string }
  | { readonly type: "replay"; readonly firstEventId: string | null }
  | {
      readonly type: "step";
      readonly events: ReadonlyArray<AgentEyesEvent>;
      readonly offset: 1 | -1;
    }
  | { readonly type: "tick"; readonly events: ReadonlyArray<AgentEyesEvent> };

export const INITIAL_AGENT_EYES_PLAYBACK: AgentEyesPlayback = { mode: "live", eventId: null };

/** Follow live, pause on an action, or replay from the first action at a steady pace. */
export function agentEyesPlayback(
  state: AgentEyesPlayback,
  action: AgentEyesAction,
): AgentEyesPlayback {
  switch (action.type) {
    case "follow":
      return INITIAL_AGENT_EYES_PLAYBACK;
    case "pause":
      return { mode: "paused", eventId: action.eventId };
    case "select":
      return { mode: "paused", eventId: action.eventId };
    case "replay":
      return action.firstEventId === null
        ? state
        : { mode: "replay", eventId: action.firstEventId };
    case "step": {
      const index = action.events.findIndex((event) => event.id === state.eventId);
      const from = index === -1 ? action.events.length - 1 : index;
      const next =
        action.events[Math.max(0, Math.min(action.events.length - 1, from + action.offset))];
      return next ? { mode: "paused", eventId: next.id } : state;
    }
    case "tick": {
      if (state.mode !== "replay") return state;
      const index = action.events.findIndex((event) => event.id === state.eventId);
      const next = action.events[index + 1];
      // Replay hands back to live once it catches up.
      return next ? { mode: "replay", eventId: next.id } : INITIAL_AGENT_EYES_PLAYBACK;
    }
  }
}

/** The event on stage: the newest while following live, else the chosen one. */
export function stagedEvent(
  events: ReadonlyArray<AgentEyesEvent>,
  playback: AgentEyesPlayback,
): AgentEyesEvent | null {
  if (playback.mode === "live" || playback.eventId === null) return events.at(-1) ?? null;
  return events.find((event) => event.id === playback.eventId) ?? events.at(-1) ?? null;
}
