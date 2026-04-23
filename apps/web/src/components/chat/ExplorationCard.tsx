import {
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  SearchIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { memo, useState } from "react";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { WorkLogEntry } from "../../session-logic";

interface ExplorationCardProps {
  entries: ReadonlyArray<WorkLogEntry>;
  isLive: boolean;
  isPendingApproval?: boolean;
}

const READ_TOOL_NAMES = new Set(["read", "cat", "head", "tail", "view", "view_file", "read_file"]);
const SEARCH_TOOL_NAMES = new Set([
  "grep",
  "glob",
  "search",
  "toolsearch",
  "find",
  "list",
  "ls",
  "list_directory",
  "codebase_search",
  "file_search",
  "tree",
  "ripgrep",
  "rg",
]);
const SEARCH_QUERY_KEYS = ["pattern", "query", "q", "searchQuery", "term"] as const;

// Project-root markers. When an absolute path contains one of these segments,
// start the displayed path from there so users see the intent ("apps/web/.../Foo.ts")
// rather than "/Users/whoever/WebstormProjects/personal/marcode/apps/web/.../Foo.ts".
const PROJECT_ROOT_MARKERS = ["apps/", "packages/", "src/", "lib/", "components/", "modules/"];

/**
 * Shorten an absolute path to something readable for the exploration row.
 * Tries, in order: starting from a known project-root marker, or falling back
 * to the last three segments of the path.
 */
function shortenPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return trimmed;
  if (!trimmed.startsWith("/") && !trimmed.includes(":\\")) {
    return trimmed;
  }
  const normalized = trimmed.replaceAll("\\", "/");
  for (const marker of PROJECT_ROOT_MARKERS) {
    const index = normalized.indexOf(`/${marker}`);
    if (index >= 0) {
      return normalized.slice(index + 1);
    }
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts.length <= 3 ? normalized.replace(/^\//, "") : parts.slice(-3).join("/");
}

/** Parse a `<path>/foo/bar</path>` segment out of Cursor/Codex-style XML detail. */
const XML_PATH_RE = /<path>([^<]+)<\/path>/i;
const XML_CONTENT_TRAILER_RE = /<content>[\s\S]*$/i;

function extractPathFromXml(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(XML_PATH_RE);
  return match?.[1]?.trim() || null;
}

/** Strip `<content>…` trailer and compact whitespace for a clean tooltip body. */
function cleanDetailForTooltip(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const stripped = value.replace(XML_CONTENT_TRAILER_RE, "").trim();
  return stripped.length > 0 ? stripped : value.trim();
}

function isReadEntry(entry: WorkLogEntry): boolean {
  if (entry.requestKind === "file-read") return true;
  if (entry.itemType === "file_read" && !isSearchToolName(entry.toolName)) return true;
  if (entry.toolName && READ_TOOL_NAMES.has(entry.toolName.toLowerCase())) return true;
  const heading = (entry.toolTitle ?? entry.label).trim().toLowerCase();
  return heading.startsWith("read");
}

function isSearchToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return SEARCH_TOOL_NAMES.has(toolName.toLowerCase());
}

function fileNameFromPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

function inputStr(input: Record<string, unknown> | undefined, key: string): string | null {
  if (!input) return null;
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function inputNum(input: Record<string, unknown> | undefined, key: string): number | null {
  if (!input) return null;
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inputFilePath(input: Record<string, unknown> | undefined): string | null {
  return (
    inputStr(input, "file_path") ??
    inputStr(input, "filePath") ??
    inputStr(input, "path") ??
    inputStr(input, "file") ??
    inputStr(input, "target_file") ??
    inputStr(input, "targetFile") ??
    inputStr(input, "directory") ??
    inputStr(input, "dir")
  );
}

function extractSearchQuery(input: Record<string, unknown> | undefined): string | null {
  for (const key of SEARCH_QUERY_KEYS) {
    const value = inputStr(input, key);
    if (value) return value;
  }
  return null;
}

function formatLineRange(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const offset = inputNum(input, "offset");
  const limit = inputNum(input, "limit");
  if (offset !== null && limit !== null) {
    return `L${offset + 1}–${offset + limit}`;
  }
  if (offset !== null) {
    return `from L${offset + 1}`;
  }
  if (limit !== null && limit < 2000) {
    return `first ${limit} lines`;
  }
  return null;
}

function explorationEntryHeading(
  entry: WorkLogEntry,
  options?: { readonly pathMode?: "short" | "full" },
): string {
  const input = entry.toolInput;
  const lower = entry.toolName?.toLowerCase();
  const pathMode = options?.pathMode ?? "short";
  // Path source precedence: structured tool input → XML detail (Cursor/Codex
  // wrap tool output like `<path>/foo</path>`) → JSON-encoded detail.
  const pathFromInput = inputFilePath(input);
  const pathFromXml = extractPathFromXml(entry.detail);
  const pathFromJsonDetail = entry.detail
    ? extractFilePathFromValue(stripToolPrefix(entry.detail))
    : null;
  const resolvedPath = pathFromInput ?? pathFromXml ?? pathFromJsonDetail;
  // `short` collapses the project-rooted prefix for the inline row; `full`
  // preserves the exact path the agent operated on, for the hover tooltip.
  const shortPath = resolvedPath
    ? pathMode === "full"
      ? resolvedPath
      : shortenPath(resolvedPath)
    : null;
  const fileName = resolvedPath ? fileNameFromPath(resolvedPath) : null;

  // Route by specific tool name when we recognize it.
  if (lower === "read" || lower === "read_file" || lower === "view" || lower === "view_file") {
    const lineRange = formatLineRange(input);
    if (shortPath && lineRange) return `Read ${shortPath} (${lineRange})`;
    if (shortPath) return `Read ${shortPath}`;
    if (fileName) return `Read ${fileName}`;
    return "Read file";
  }

  if (lower === "grep" || lower === "ripgrep" || lower === "rg") {
    const pattern = inputStr(input, "pattern") ?? inputStr(input, "query");
    if (pattern && shortPath) return `Searched ${pattern} in ${shortPath}`;
    if (pattern) return `Searched ${pattern}`;
    if (shortPath) return `Searched ${shortPath}`;
    return `Searched ${extractSearchSummaryFromDetail(entry.detail)}`;
  }

  if (lower === "glob") {
    const pattern = inputStr(input, "pattern");
    if (pattern && shortPath) return `Glob ${pattern} in ${shortPath}`;
    if (pattern) return `Glob ${pattern}`;
    return `Glob ${extractSearchSummaryFromDetail(entry.detail)}`;
  }

  if (lower === "list" || lower === "ls" || lower === "list_directory") {
    if (shortPath) return `Listed ${shortPath}`;
    return `Listed ${extractPathSummaryFromDetail(entry.detail)}`;
  }

  if (lower === "find") {
    if (shortPath) return `Found ${shortPath}`;
    return `Found ${extractPathSummaryFromDetail(entry.detail)}`;
  }

  if (lower === "tree") {
    if (shortPath) return `Tree ${shortPath}`;
    return "Tree";
  }

  if (lower === "toolsearch") {
    const query = extractSearchQuery(input);
    if (query) return `Searched tools for ${query}`;
    const summary = extractSearchSummaryFromDetail(entry.detail);
    return summary ? `Searched tools ${summary}` : "Searched tools";
  }

  if (
    lower === "codebase_search" ||
    lower === "file_search" ||
    (lower && lower.includes("search"))
  ) {
    const query = extractSearchQuery(input);
    if (query && shortPath) return `Searched ${query} in ${shortPath}`;
    if (query) return `Searched ${query}`;
    if (shortPath) return `Searched ${shortPath}`;
    const summary = extractSearchSummaryFromDetail(entry.detail);
    return summary ? `Searched ${summary}` : "Searched";
  }

  // Fallback: route by canonical itemType when toolName is missing/unknown.
  // This is the common Cursor ACP path, where `kind: "read"` is the only
  // signal and we've lost specificity.
  if (entry.itemType === "file_read") {
    if (shortPath) return `Read ${shortPath}`;
    if (fileName) return `Read ${fileName}`;
    return "Read file";
  }

  // Final fallback: never print the raw XML-ish detail as the heading.
  const raw = (entry.toolTitle ?? entry.label).trim();
  if (isGenericLabel(raw) && entry.detail) {
    return cleanDetailAsHeading(entry.detail);
  }
  const titled = raw.length === 0 ? "Explored" : `${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;

  const fallbackQuery = extractSearchQuery(input);
  if (fallbackQuery && shortPath) return `${titled} ${fallbackQuery} in ${shortPath}`;
  if (fallbackQuery) return `${titled} ${fallbackQuery}`;
  if (shortPath) return `${titled} ${shortPath}`;

  if (entry.detail) {
    const summary = extractSearchSummaryFromDetail(entry.detail);
    if (summary && summary !== titled) return `${titled} ${summary}`;
  }
  return titled;
}

function isGenericLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return (
    lower === "tool call" ||
    lower === "tool" ||
    lower === "tool call completed" ||
    lower === "tool call started" ||
    lower === "tool updated" ||
    lower === "item"
  );
}

function stripToolPrefix(value: string): string {
  return value.replace(/^[A-Za-z_]+:\s*/, "").trim();
}

function tryParseJson(value: string): Record<string, unknown> | null {
  if (!value.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractFilePathFromValue(value: string): string | null {
  const parsed = tryParseJson(value);
  if (parsed) {
    const path =
      typeof parsed.file_path === "string"
        ? parsed.file_path
        : typeof parsed.filePath === "string"
          ? parsed.filePath
          : typeof parsed.path === "string"
            ? parsed.path
            : null;
    return path;
  }
  if (value.includes("/")) return value.trim();
  return null;
}

function extractFileNameFromDetail(detail: string | undefined): string {
  if (!detail) return "";
  const cleaned = stripToolPrefix(detail);
  const filePath = extractFilePathFromValue(cleaned);
  if (filePath) return fileNameFromPath(filePath);
  return "";
}

function extractSearchSummaryFromDetail(detail: string | undefined): string {
  if (!detail) return "";
  const cleaned = stripToolPrefix(detail);
  const parsed = tryParseJson(cleaned);
  if (parsed) {
    const query = SEARCH_QUERY_KEYS.map((key) => parsed[key]).find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    const path = typeof parsed.path === "string" ? parsed.path : null;
    if (query && path) return `${query} in ${fileNameFromPath(path)}`;
    if (query) return query;
  }
  return cleaned.slice(0, 120);
}

function extractPathSummaryFromDetail(detail: string | undefined): string {
  if (!detail) return "";
  const cleaned = stripToolPrefix(detail);
  const filePath = extractFilePathFromValue(cleaned);
  if (filePath) {
    const parts = filePath.split("/");
    return parts.slice(-2).join("/");
  }
  return cleaned.slice(0, 120);
}

function cleanDetailAsHeading(detail: string): string {
  const cleaned = stripToolPrefix(detail);
  const filePath = extractFilePathFromValue(cleaned);
  if (filePath) return `Read ${fileNameFromPath(filePath)}`;
  return cleaned.slice(0, 80);
}

function ExplorationEntryRow(props: { entry: WorkLogEntry }) {
  const { entry } = props;
  const isRead = isReadEntry(entry);
  const Icon = isRead ? EyeIcon : SearchIcon;
  const heading = explorationEntryHeading(entry);
  // Tooltip shows the same heading but with the FULL path, so hovering
  // reveals whatever got truncated by the row's narrow layout (and shows
  // the agent's actual absolute path, not just the project-relative form).
  const fullHeading = explorationEntryHeading(entry, { pathMode: "full" });
  const tooltipBody = fullHeading !== heading ? fullHeading : null;

  const rowContent = (
    <div className="flex items-center gap-2 rounded-lg px-1 py-0.5">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/50">
        <Icon className="size-3" />
      </span>
      <p className="min-w-0 flex-1 truncate text-[11px] leading-5 text-muted-foreground/70">
        <span className="text-foreground/70">{heading}</span>
      </p>
    </div>
  );

  if (!tooltipBody) return rowContent;

  return (
    <Tooltip>
      <TooltipTrigger render={rowContent} />
      <TooltipPopup className="max-w-[min(90vw,640px)] break-all text-[11px]">
        {tooltipBody}
      </TooltipPopup>
    </Tooltip>
  );
}

export const ExplorationCard = memo(function ExplorationCard(props: ExplorationCardProps) {
  const { entries, isLive, isPendingApproval = false } = props;
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) return null;

  const readCount = entries.filter(isReadEntry).length;
  const searchCount = entries.length - readCount;

  const headerParts: string[] = [];
  if (readCount > 0) headerParts.push(`${readCount} file${readCount !== 1 ? "s" : ""}`);
  if (searchCount > 0) headerParts.push(`${searchCount} search${searchCount !== 1 ? "es" : ""}`);
  const summary = headerParts.join(", ");

  const verb = isLive ? "Exploring" : "Explored";
  const ToggleIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      data-scroll-anchor-target
      className={cn(
        "overflow-hidden rounded-xl border border-border/40 border-l-2 bg-card/25",
        isLive ? "border-l-blue-400/40" : "border-l-blue-400/20",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-muted/20"
      >
        <ToggleIcon className="size-3 shrink-0 text-muted-foreground/50" />
        <SearchIcon className="size-3.5 shrink-0 text-blue-400/50" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
          {verb} {summary}
        </span>
        {isPendingApproval ? (
          <span className="flex items-center gap-1 text-[10px] text-blue-400/70">
            <ShieldQuestionIcon className="size-3" />
            Approval requested
          </span>
        ) : (
          isLive && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-blue-400/60" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/20 px-2 py-1">
          {entries.map((entry) => (
            <ExplorationEntryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
});
