import * as Equal from "effect/Equal";
import {
  formatDuration,
  normalizeCommandValue,
  splitMcpToolName,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type TurnPlanEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * Follow re-arm band above the hard bottom. Strict on purpose: LegendList's
 * isNearEnd fires within half a viewport, which re-armed live-follow while the
 * user was reading history and yanked them back down on the next stream chunk.
 * A small pixel band (instead of the 1px isAtEnd epsilon alone) keeps re-arming
 * reliable while streaming content is still growing under the viewport.
 */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(
  state: TimelineEndState | undefined,
  endInset = 0,
): boolean | undefined {
  if (!state) {
    return undefined;
  }
  if (state.isAtEnd) {
    return true;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the end inset (composer overlay), so subtract it to
  // measure the distance to the real content bottom.
  return contentLength - scroll - scrollLength - endInset <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "turn-plan";
      id: string;
      createdAt: string;
      turnPlan: TurnPlanEntry;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

// ---------------------------------------------------------------------------
// Tool-call phrasing — turns provider payloads into a human row
// ---------------------------------------------------------------------------

export interface ToolCallDisplay {
  heading: string;
  preview: string | null;
}

const TOOL_PREVIEW_MAX_LENGTH = 120;
/** `Read: {"file_path":"/x.ts"}` / `Bash: git status` — how legacy activities persisted the call. */
const LEGACY_TOOL_PREFIX_PATTERN = /^([A-Za-z][\w-]*):\s*([\s\S]+)$/;

type ToolIdentityKind =
  | "read"
  | "write"
  | "edit"
  | "command"
  | "grep"
  | "glob"
  | "web-search"
  | "web-fetch"
  | "subagent"
  | "skill"
  | "todo";

interface ToolIdentity {
  heading: string;
  kind: ToolIdentityKind;
}

function toolIdentities(
  kind: ToolIdentityKind,
  heading: string,
  names: ReadonlyArray<string>,
): ReadonlyArray<readonly [string, ToolIdentity]> {
  return names.map((name) => [name, { heading, kind }] as const);
}

/** Provider tool names (lowercased) mapped to the sentence the row should read as. */
const TOOL_IDENTITIES: ReadonlyMap<string, ToolIdentity> = new Map([
  ...toolIdentities("read", "Read file", ["read", "read_file", "readfile", "view"]),
  ...toolIdentities("write", "Wrote file", ["write", "write_file", "writefile"]),
  ...toolIdentities("edit", "Edited file", [
    "edit",
    "multiedit",
    "multi_edit",
    "notebookedit",
    "notebook_edit",
    "str_replace_editor",
  ]),
  ...toolIdentities("command", "Ran command", [
    "bash",
    "sh",
    "shell",
    "zsh",
    "terminal",
    "command",
    "exec",
    "execute_command",
    "local_shell",
    "run_command",
    "run_terminal_cmd",
  ]),
  ...toolIdentities("grep", "Searched code", ["grep", "ripgrep"]),
  ...toolIdentities("glob", "Listed files", ["glob", "list"]),
  ...toolIdentities("web-search", "Searched the web", ["websearch", "web_search"]),
  ...toolIdentities("web-fetch", "Fetched page", ["webfetch", "web_fetch", "fetch"]),
  ...toolIdentities("subagent", "Ran subagent", ["task", "agent"]),
  ...toolIdentities("skill", "Ran skill", ["skill"]),
  ...toolIdentities("todo", "Updated to-do list", ["todowrite", "todo_write"]),
]);

const PRIMARY_TOOL_ARG_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "url",
  "query",
  "pattern",
  "prompt",
  "description",
  "name",
  "title",
  "skill",
] as const;

/**
 * Argument names that address a file. OpenCode (and the ACP `rawInput`
 * passthrough) spell these camelCase, Claude and Codex snake_case, so both have
 * to be listed or the row falls back to dumping the whole tool output.
 */
const FILE_PATH_TOOL_ARG_KEYS = [
  "file_path",
  "filePath",
  "notebook_path",
  "notebookPath",
  "path",
] as const;

const PATH_TOOL_ARG_KEYS = new Set<string>(FILE_PATH_TOOL_ARG_KEYS);

function toolIdentityFor(toolName: string): ToolIdentity | undefined {
  return TOOL_IDENTITIES.get(toolName.toLowerCase());
}

function collapseInlineWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateToolPreview(value: string, maxLength = TOOL_PREVIEW_MAX_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

/** `/a/b.ts`, `~/a`, `./a`, `../a`, `C:\a`, `\\host\share` — rooted somewhere real. */
function isAnchoredFilePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("\\\\") ||
    /^\.{1,2}[/\\]/.test(value) ||
    /^[A-Za-z]:[/\\]/.test(value)
  );
}

/**
 * Only consulted for arguments that are *not* named after a path, so it has to
 * stay conservative: `refs/heads/main`, `owner/repo` and `@scope/pkg` all carry
 * a slash and none of them may be rewritten as a workspace file.
 */
function looksLikeFilePath(value: string): boolean {
  if (hasUriScheme(value) || /\s/.test(value) || !/[/\\]/.test(value)) {
    return false;
  }
  return isAnchoredFilePath(value) || /\.[A-Za-z0-9]{1,10}$/.test(value);
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/** `preview_status` / `previewStatus` → `Preview status`. */
function humanizeToolName(toolName: string): string {
  const words = toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  const [first, ...rest] = words;
  if (!first) {
    return toolName;
  }
  return [capitalizePhrase(first), ...rest].join(" ");
}

function toolArgText(input: Record<string, unknown> | undefined, key: string): string | null {
  if (!input) {
    return null;
  }
  const value = input[key];
  if (typeof value === "string") {
    const collapsed = collapseInlineWhitespace(value);
    return collapsed.length > 0 ? collapsed : null;
  }
  if (Array.isArray(value)) {
    const joined = collapseInlineWhitespace(
      value.filter((part): part is string => typeof part === "string").join(" "),
    );
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function toolArgPath(
  input: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
  workspaceRoot: string | undefined,
): string | null {
  for (const key of keys) {
    const value = toolArgText(input, key);
    if (value) {
      return formatToolArgPreview(key, value, workspaceRoot);
    }
  }
  return null;
}

/**
 * Command arguments arrive as strings *and* as argv arrays
 * (`["bash","-lc","git status"]`), so they get the same normalization that
 * produced `entry.command` instead of a raw space-join.
 */
function toolArgCommand(input: Record<string, unknown> | undefined): string | null {
  if (!input) {
    return null;
  }
  for (const key of ["command", "cmd"] as const) {
    const normalized = normalizeCommandValue(input[key]);
    if (normalized === null) {
      continue;
    }
    const collapsed = collapseInlineWhitespace(normalized);
    if (collapsed.length > 0) {
      return truncateToolPreview(collapsed);
    }
  }
  return null;
}

function toolArgPlain(
  input: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const value = toolArgText(input, key);
    if (value) {
      return truncateToolPreview(value);
    }
  }
  return null;
}

function isWorkspacePathArg(key: string, value: string): boolean {
  // A URL is never a workspace file, whatever the argument happens to be named.
  if (hasUriScheme(value)) {
    return false;
  }
  if (PATH_TOOL_ARG_KEYS.has(key)) {
    return true;
  }
  if ((PRIMARY_TOOL_ARG_KEYS as ReadonlyArray<string>).includes(key)) {
    return false;
  }
  return looksLikeFilePath(value);
}

/**
 * `workspaceRoot === undefined` means "do not rewrite": callers pass it for
 * arguments that address a remote system (MCP servers), where a workspace
 * prefix would invent a local file that does not exist.
 */
function formatToolArgPreview(
  key: string,
  value: string,
  workspaceRoot: string | undefined,
): string {
  return truncateToolPreview(
    workspaceRoot !== undefined && isWorkspacePathArg(key, value)
      ? formatWorkspaceRelativePath(value, workspaceRoot)
      : value,
  );
}

/** Best single argument to show beside the heading for tools with no bespoke phrasing. */
function primaryToolArg(
  input: Record<string, unknown> | undefined,
  workspaceRoot: string | undefined,
): string | null {
  if (!input) {
    return null;
  }
  for (const key of PRIMARY_TOOL_ARG_KEYS) {
    const value = toolArgText(input, key);
    if (value) {
      return formatToolArgPreview(key, value, workspaceRoot);
    }
  }
  for (const [key, rawValue] of Object.entries(input)) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const value = collapseInlineWhitespace(rawValue);
    if (value.length > 0) {
      return formatToolArgPreview(key, value, workspaceRoot);
    }
  }
  return null;
}

function changedFilesPreview(
  entry: Pick<WorkLogEntry, "changedFiles">,
  workspaceRoot: string | undefined,
): string | null {
  const changedFiles = entry.changedFiles ?? [];
  const [firstPath] = changedFiles;
  if (!firstPath) {
    return null;
  }
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return changedFiles.length === 1
    ? displayPath
    : `${displayPath} +${changedFiles.length - 1} more`;
}

/** The pre-existing row preview: command, then detail, then the changed-file summary. */
function fallbackWorkEntryPreview(
  entry: Pick<WorkLogEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
): string | null {
  if (entry.command) return entry.command;
  if (entry.detail) return entry.detail;
  return changedFilesPreview(entry, workspaceRoot);
}

export function fallbackWorkEntryDisplay(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
): ToolCallDisplay {
  return {
    heading: capitalizePhrase(normalizeCompactToolLabel(entry.toolTitle ?? entry.label)),
    preview: fallbackWorkEntryPreview(entry, workspaceRoot),
  };
}

interface ToolCallSubject {
  toolName: string;
  toolServer?: string;
  input?: Record<string, unknown>;
  /** True when the identity came from `detail`, which must then not be echoed as the preview. */
  fromDetail: boolean;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  if (!value.startsWith("{") || !value.endsWith("}")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface LegacyToolCallParse {
  subject: Omit<ToolCallSubject, "fromDetail">;
  /** True when `<rest>` was a JSON object rather than a bare command string. */
  structured: boolean;
}

function parseLegacyToolCallText(
  entry: WorkLogEntry,
  value: string | undefined,
): LegacyToolCallParse | null {
  if (!value) {
    return null;
  }
  const match = LEGACY_TOOL_PREFIX_PATTERN.exec(value.trim());
  const rawName = match?.[1];
  const rest = match?.[2]?.trim();
  if (!rawName || !rest) {
    return null;
  }
  const { server, name } = splitMcpToolName(rawName);
  const input = parseJsonObject(rest);
  if (input) {
    // `Result: {"ok":true}` is prose that happens to quote JSON. Letting an
    // unknown word take over the heading also drops the text (the detail is
    // suppressed as an echo of the call), so the row would carry nothing.
    if (!server && !toolIdentityFor(name)) {
      return null;
    }
    return {
      subject: { toolName: name, ...(server ? { toolServer: server } : {}), input },
      structured: true,
    };
  }
  // Only a shell prefix is safe to read as free text ("Bash: git status").
  // Anything else with a colon is ordinary prose ("Error: ENOENT ...").
  if (toolIdentityFor(name)?.kind !== "command") {
    return null;
  }
  // Plenty of prose opens with a shell word and a colon — command output
  // ("bash: foo: command not found"), runtime errors ("sh: permission
  // denied"), pending approvals ("Bash: rm -rf /tmp/build"). Claiming a
  // command *ran* is only safe when the row carries a derived command that
  // corroborates this very text.
  const command = entry.command?.trim();
  if (!command || (command !== value.trim() && command !== rest)) {
    return null;
  }
  return { subject: { toolName: name, input: { command: rest } }, structured: false };
}

/** OpenCode titled its rows with the bare tool name (`bash`, `edit`, `webfetch`). */
function toolNameFromTitle(title: string | undefined): string | null {
  if (!title) {
    return null;
  }
  const normalized = normalizeCompactToolLabel(title);
  if (normalized.length === 0 || /\s/.test(normalized)) {
    return null;
  }
  return toolIdentityFor(normalized) ? normalized : null;
}

function resolveToolCallSubject(entry: WorkLogEntry): ToolCallSubject | null {
  if (entry.toolName) {
    return {
      toolName: entry.toolName,
      ...(entry.toolServer !== undefined ? { toolServer: entry.toolServer } : {}),
      ...(entry.toolInput !== undefined ? { input: entry.toolInput } : {}),
      fromDetail: false,
    };
  }
  const fromDetail = parseLegacyToolCallText(entry, entry.detail);
  if (fromDetail) {
    return { ...fromDetail.subject, fromDetail: true };
  }
  const fromLabel = parseLegacyToolCallText(entry, entry.label);
  if (fromLabel) {
    return { ...fromLabel.subject, fromDetail: false };
  }
  const fromTitle = toolNameFromTitle(entry.toolTitle);
  return fromTitle ? { toolName: fromTitle, fromDetail: false } : null;
}

/** Claude repeats the call as `<Tool>: <json>` in `detail`; never show that back to the user. */
function detailEchoesToolCall(entry: WorkLogEntry, subject: ToolCallSubject): boolean {
  if (subject.fromDetail) {
    return true;
  }
  const match = LEGACY_TOOL_PREFIX_PATTERN.exec(entry.detail?.trim() ?? "");
  const rawName = match?.[1];
  if (!rawName) {
    return false;
  }
  return splitMcpToolName(rawName).name.toLowerCase() === subject.toolName.toLowerCase();
}

/**
 * Approval rows describe a request that has *not* run yet, and the provider
 * writes the request itself into `detail` ("Bash: rm -rf /tmp/build"). Phrasing
 * one as a finished call is the single worst thing this module could do, so
 * they keep the plain request wording.
 */
function isPendingRequestEntry(entry: WorkLogEntry): boolean {
  return entry.requestKind !== undefined;
}

export function describeToolCallWorkEntry(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
): ToolCallDisplay {
  const subject = isPendingRequestEntry(entry) ? null : resolveToolCallSubject(entry);
  if (!subject) {
    return fallbackWorkEntryDisplay(entry, workspaceRoot);
  }

  const { input } = subject;
  const skipDetail = detailEchoesToolCall(entry, subject);
  const fallbackPreview = (): string | null => {
    if (entry.command) return entry.command;
    if (!skipDetail && entry.detail) return entry.detail;
    return changedFilesPreview(entry, workspaceRoot);
  };

  if (subject.toolServer) {
    return {
      heading: `${subject.toolServer} · ${subject.toolName}`,
      // MCP arguments address the server, not this checkout: a `path` here is a
      // remote resource, so it is shown exactly as the model sent it.
      preview: primaryToolArg(input, undefined) ?? fallbackPreview(),
    };
  }

  const identity = toolIdentityFor(subject.toolName);
  if (!identity) {
    return {
      heading: humanizeToolName(subject.toolName),
      preview: primaryToolArg(input, workspaceRoot) ?? fallbackPreview(),
    };
  }

  const { heading } = identity;
  switch (identity.kind) {
    case "read":
      return {
        heading,
        preview: toolArgPath(input, FILE_PATH_TOOL_ARG_KEYS, workspaceRoot) ?? fallbackPreview(),
      };
    case "write":
    case "edit":
      return {
        heading,
        preview:
          changedFilesPreview(entry, workspaceRoot) ??
          toolArgPath(input, FILE_PATH_TOOL_ARG_KEYS, workspaceRoot) ??
          fallbackPreview(),
      };
    case "command":
      return {
        heading,
        preview: toolArgCommand(input) ?? fallbackPreview(),
      };
    case "grep":
      return {
        heading,
        preview: toolArgPlain(input, ["pattern", "query"]) ?? fallbackPreview(),
      };
    case "glob":
      return {
        heading,
        preview:
          toolArgPlain(input, ["pattern"]) ??
          toolArgPath(input, ["path"], workspaceRoot) ??
          fallbackPreview(),
      };
    case "web-search":
      return {
        heading,
        preview: toolArgPlain(input, ["query"]) ?? fallbackPreview(),
      };
    case "web-fetch":
      return {
        heading,
        preview: toolArgPlain(input, ["url"]) ?? fallbackPreview(),
      };
    case "subagent":
      return {
        heading,
        preview: toolArgPlain(input, ["description", "prompt"]) ?? fallbackPreview(),
      };
    case "skill":
      return {
        heading,
        preview: toolArgPlain(input, ["skill", "name", "command"]) ?? fallbackPreview(),
      };
    case "todo":
      return { heading, preview: null };
  }
}

// ---------------------------------------------------------------------------
// Work-entry row chrome — icon choice and expanded body
// ---------------------------------------------------------------------------

export type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

export function workToneIconName(tone: WorkLogEntry["tone"]): WorkEntryIconName {
  if (tone === "error") return "circle-alert";
  if (tone === "thinking") return "bot";
  if (tone === "info") return "check";
  return "zap";
}

export function workEntryIconName(workEntry: WorkLogEntry): WorkEntryIconName {
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntry.requestKind === "command") return "terminal";
  if (workEntry.requestKind === "file-read") return "eye";
  if (workEntry.requestKind === "file-change") return "square-pen";

  // Adapters classify itemType by keyword, so `mcp__github__create_pr` lands on
  // `file_change`. The resolved server name is the reliable MCP signal.
  if (workEntry.toolServer) return "wrench";

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return "terminal";
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return "square-pen";
  }
  if (workEntry.itemType === "web_search") return "globe";
  if (workEntry.itemType === "image_view") return "eye";

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
      return "hammer";
    case "collab_agent_tool_call":
      return "bot";
  }

  // Subagent lifecycle rows (grouped by taskId) get agent identity chrome.
  if (workEntry.taskId) {
    return "bot";
  }

  return workToneIconName(workEntry.tone);
}

/**
 * Tool input is passed through by the adapters verbatim — a Write call carries
 * the entire file — so it is bounded before it reaches the expanded body.
 */
const TOOL_INPUT_STRING_MAX_LENGTH = 400;
const TOOL_INPUT_ARRAY_MAX_ITEMS = 20;
const TOOL_INPUT_OBJECT_MAX_ENTRIES = 20;
const TOOL_INPUT_MAX_DEPTH = 4;

function boundToolInputValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    const overflow = value.length - TOOL_INPUT_STRING_MAX_LENGTH;
    return overflow > 0
      ? `${value.slice(0, TOOL_INPUT_STRING_MAX_LENGTH)}… (+${overflow} more characters)`
      : value;
  }
  if (Array.isArray(value)) {
    if (depth >= TOOL_INPUT_MAX_DEPTH) {
      return `… (${value.length} items)`;
    }
    const kept = value
      .slice(0, TOOL_INPUT_ARRAY_MAX_ITEMS)
      .map((item) => boundToolInputValue(item, depth + 1));
    const overflow = value.length - TOOL_INPUT_ARRAY_MAX_ITEMS;
    return overflow > 0 ? [...kept, `… (+${overflow} more items)`] : kept;
  }
  if (value !== null && typeof value === "object") {
    if (depth >= TOOL_INPUT_MAX_DEPTH) {
      return "…";
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const kept: Array<[string, unknown]> = entries
      .slice(0, TOOL_INPUT_OBJECT_MAX_ENTRIES)
      .map(([key, item]) => [key, boundToolInputValue(item, depth + 1)]);
    const overflow = entries.length - TOOL_INPUT_OBJECT_MAX_ENTRIES;
    if (overflow > 0) {
      kept.push(["…", `(+${overflow} more entries)`]);
    }
    return Object.fromEntries(kept);
  }
  return value;
}

export function formatToolInputBlock(input: Record<string, unknown>): string {
  return `Input\n${JSON.stringify(boundToolInputValue(input, 1), null, 2)}`;
}

export function workEntryRawCommand(
  workEntry: Pick<WorkLogEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function hasToolInputBlock(workEntry: WorkLogEntry): boolean {
  return workEntry.toolInput !== undefined && Object.keys(workEntry.toolInput).length > 0;
}

function hasMcpBlock(workEntry: WorkLogEntry): boolean {
  return workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined;
}

/**
 * Cheap mirror of `buildToolCallExpandedBody() !== null`, so a collapsed row
 * never pays for serialising the body it is not showing (tool rows re-render on
 * every streaming update). Kept in lockstep with the builder below by test.
 */
export function hasToolCallExpandedBody(workEntry: WorkLogEntry): boolean {
  return (
    hasMcpBlock(workEntry) ||
    Boolean(workEntryRawCommand(workEntry)?.trim()) ||
    Boolean(workEntry.command?.trim()) ||
    Boolean(workEntry.detail?.trim()) ||
    (workEntry.changedFiles?.length ?? 0) > 0 ||
    hasToolInputBlock(workEntry)
  );
}

export function buildToolCallExpandedBody(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  const mcpBlock = hasMcpBlock(workEntry);
  if (mcpBlock) {
    blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  // The row heading only shows one argument; the MCP block already carries the
  // full call, so the raw input is appended for every other tool.
  if (!mcpBlock && workEntry.toolInput && hasToolInputBlock(workEntry)) {
    blocks.push(formatToolInputBlock(workEntry.toolInput));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      // Agent-spawn CTA rows never fold: workflows outlive their launching
      // turn (dynamic spawns, background execution), and folding the CTA
      // when the turn settles makes a still-running fleet invisible.
      if (entry.kind === "work" && entry.entry.agentSpawn !== undefined) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleGroupedEntries.length > 0) {
        if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
          });
        } else {
          const groupId = `work-group:${timelineEntry.id}`;
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          // Agent-spawn CTA rows are always visible: a running fleet must
          // never hide behind a "+N tool calls" toggle. Selection is by
          // membership (spawn OR recent-tail), preserving the group's
          // chronological order in both collapsed and expanded states
          // (review finding: concatenating two filtered lists moved a
          // mid-group spawn row above earlier tool rows).
          const overflowCandidates = visibleGroupedEntries.filter(
            (entry) => entry.agentSpawn === undefined,
          );
          const hiddenEntries = overflowCandidates.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
          const hiddenIds = new Set(hiddenEntries.map((entry) => entry.id));
          const visibleEntries = visibleGroupedEntries.filter(
            (entry) => entry.agentSpawn !== undefined || !hiddenIds.has(entry.id),
          );
          const renderedEntries = expanded ? visibleGroupedEntries : visibleEntries;

          for (const workEntry of renderedEntries) {
            nextRows.push({
              kind: "work",
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
            });
          }

          if (hiddenEntries.length > 0) {
            nextRows.push({
              kind: "work-toggle",
              id: `work-toggle:${timelineEntry.id}`,
              createdAt: timelineEntry.createdAt,
              groupId,
              hiddenCount: hiddenEntries.length,
              expanded,
              onlyToolEntries: visibleGroupedEntries.every((entry) =>
                workLogEntryIsToolLike(entry),
              ),
            });
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "turn-plan") {
      nextRows.push({
        kind: "turn-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        turnPlan: timelineEntry.turnPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "turn-plan": {
      const bp = b as typeof a;
      // Plans rewrite in place: compare the snapshot's identity fields so an
      // unchanged plan keeps its row reference (virtualization stability).
      return a.createdAt === bp.createdAt && a.turnPlan.plan === bp.turnPlan.plan;
    }

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
