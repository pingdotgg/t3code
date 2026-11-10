import { type HtmlRenderReference } from "./htmlRender.ts";
import { isHostPath } from "./path.ts";
import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

export type PublishedArtifactKind = "claude-artifact" | "html-render" | "temp-file";

export interface PublishedArtifact {
  readonly id: string;
  readonly kind: PublishedArtifactKind;
  readonly title: string;
  readonly url: string | null;
  readonly path: string | null;
  readonly htmlRender: HtmlRenderReference | null;
  readonly toolName: string | null;
  readonly itemId: string;
}

const CLAUDE_ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9._~-]+/i;
const PUBLISHED_AT_URL = /Published at\s+(https:\/\/\S+)/i;

/** Well-known OS / provider scratch roots. Not a filesystem hook — only projected writes. */
const TEMP_PATH_PREFIXES = [
  "/tmp/",
  "/private/tmp/",
  "/var/tmp/",
  "/private/var/tmp/",
  "/var/folders/",
  "/private/var/folders/",
  "/dev/shm/",
] as const;

const WINDOWS_TEMP_PATH =
  /^(?:[a-z]:[\\/])?(?:users[\\/][^\\/]+[\\/])?appdata[\\/]local[\\/]temp[\\/]/i;

const WRITE_OPERATIONS = new Set(["create", "update", "write", "add", "modify"]);
const WRITE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "create",
  "create_file",
  "write_file",
  "edit_file",
  "applypatch",
  "apply_patch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function unwrapToolPayload(output: unknown): unknown {
  if (!isRecord(output)) return output;
  if ("value" in output) return unwrapToolPayload(output.value);
  if ("result" in output) return unwrapToolPayload(output.result);
  if ("toolUseResult" in output) return unwrapToolPayload(output.toolUseResult);
  if ("structured_output" in output) return unwrapToolPayload(output.structured_output);
  return output;
}

function collectText(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectText(entry, into);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ["text", "content", "message", "output", "summary"] as const) {
    if (key in value) collectText(value[key], into);
  }
}

function extractClaudeArtifactFields(output: unknown): {
  readonly url: string | null;
  readonly path: string | null;
  readonly title: string | null;
} {
  const payload = unwrapToolPayload(output);
  const texts: string[] = [];
  collectText(output, texts);
  const joined = texts.join("\n");

  let url: string | null = null;
  let path: string | null = null;
  let title: string | null = null;

  if (isRecord(payload)) {
    url = readString(payload.url);
    path = readString(payload.path) ?? readString(payload.file_path);
    title =
      readString(payload.title) ?? readString(payload.label) ?? readString(payload.description);
  }

  if (url === null) {
    const published = joined.match(PUBLISHED_AT_URL)?.[1] ?? joined.match(CLAUDE_ARTIFACT_URL)?.[0];
    url = published ?? null;
  } else if (!CLAUDE_ARTIFACT_URL.test(url) && !url.startsWith("https://claude.ai/")) {
    // Keep non-claude URLs from structured results; Claude may return other hosts later.
  }

  return { url, path, title };
}

function isClaudeArtifactToolName(toolName: string | null | undefined): boolean {
  if (toolName === null || toolName === undefined) return false;
  const normalized = toolName.trim().toLowerCase();
  // ArtifactComments / ArtifactData are companions, not the publish tool.
  return normalized === "artifact";
}

function normalizePathSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

export function isTempArtifactPath(value: string): boolean {
  const trimmed = value.trim();
  if (!isHostPath(trimmed)) return false;
  const normalized = normalizePathSeparators(trimmed);
  const lower = normalized.toLowerCase();
  if (
    TEMP_PATH_PREFIXES.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix))
  ) {
    return true;
  }
  if (WINDOWS_TEMP_PATH.test(trimmed) || WINDOWS_TEMP_PATH.test(normalized)) return true;
  // Bare `C:\Temp\...` / `\Temp\...` outside AppData.
  return /^[a-z]:[\\/]temp[\\/]/i.test(trimmed) || /^[\\/]temp[\\/]/i.test(trimmed);
}

function pathBasename(value: string): string {
  const normalized = normalizePathSeparators(value).replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || value;
}

function readToolPath(input: unknown): string | null {
  if (!isRecord(input)) return null;
  return (
    readString(input.path) ??
    readString(input.file_path) ??
    readString(input.filePath) ??
    readString(input.target_file) ??
    readString(input.targetFile)
  );
}

function isWriteToolName(toolName: string | null | undefined): boolean {
  if (toolName === null || toolName === undefined) return false;
  const normalized = toolName.trim().toLowerCase();
  const bare = normalized.includes("__")
    ? (normalized.split("__").at(-1) ?? normalized)
    : normalized;
  return WRITE_TOOL_NAMES.has(bare) || bare.endsWith("_write") || bare.endsWith("_edit");
}

function rememberTempFile(
  byKey: Map<string, PublishedArtifact>,
  input: {
    readonly path: string;
    readonly itemId: string;
    readonly toolName: string | null;
    readonly title?: string | null;
  },
) {
  if (!isTempArtifactPath(input.path)) return;
  const key = `temp-file:${input.path}`;
  byKey.set(key, {
    id: key,
    kind: "temp-file",
    title: input.title?.trim() || pathBasename(input.path),
    url: null,
    path: input.path,
    htmlRender: null,
    toolName: input.toolName,
    itemId: input.itemId,
  });
}

/** Pending, rejected, and failed writes are not session products yet. */
function isCompletedArtifactItem(status: string | null | undefined): boolean {
  return status === "completed";
}

export function publishedArtifactsFromTurnItems(
  items: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly status?: string | null | undefined;
    readonly toolName?: string | null | undefined;
    readonly fileName?: string | null | undefined;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly changes?:
      | ReadonlyArray<{
          readonly operation?: string | null | undefined;
          readonly path?: string | null | undefined;
          readonly oldPath?: string | null | undefined;
        }>
      | undefined;
  }>,
): ReadonlyArray<PublishedArtifact> {
  const byKey = new Map<string, PublishedArtifact>();

  for (const item of items) {
    if (item.type === "file_change") {
      if (!isCompletedArtifactItem(item.status)) continue;
      const changes = item.changes ?? [];
      if (changes.length > 0) {
        for (const change of changes) {
          const operation = change.operation?.trim().toLowerCase() ?? "update";
          if (!WRITE_OPERATIONS.has(operation)) continue;
          const path = readString(change.path);
          if (path) {
            rememberTempFile(byKey, {
              path,
              itemId: item.id,
              toolName: item.toolName ?? null,
            });
          }
        }
      } else {
        const path = readString(item.fileName);
        if (path) {
          rememberTempFile(byKey, {
            path,
            itemId: item.id,
            toolName: item.toolName ?? null,
          });
        }
      }
      continue;
    }

    if (item.type !== "dynamic_tool") continue;
    if (!isCompletedArtifactItem(item.status)) continue;

    if (isClaudeArtifactToolName(item.toolName)) {
      const fields = extractClaudeArtifactFields(item.output);
      if (fields.url === null && fields.path === null) continue;
      const key = fields.url ?? fields.path ?? item.id;
      const existing = byKey.get(key);
      const title =
        fields.title ??
        (isRecord(item.input)
          ? (readString(item.input.label) ??
            readString(item.input.description) ??
            readString(item.input.file_path))
          : null) ??
        "Claude artifact";
      const next: PublishedArtifact = {
        id: existing?.id ?? `claude-artifact:${key}`,
        kind: "claude-artifact",
        title,
        url: fields.url,
        path: fields.path,
        htmlRender: null,
        toolName: item.toolName ?? null,
        itemId: item.id,
      };
      byKey.set(key, next);
      continue;
    }

    if (resolveT3McpToolId(item.toolName) === "html_render") {
      const htmlRender = htmlRenderFromToolItem({
        toolName: item.toolName,
        output: item.output,
      });
      if (htmlRender === undefined) continue;
      const key = `html-render:${htmlRender.attachmentId}`;
      byKey.set(key, {
        id: key,
        kind: "html-render",
        title: htmlRender.title,
        url: null,
        path: null,
        htmlRender,
        toolName: item.toolName ?? null,
        itemId: item.id,
      });
      continue;
    }

    if (isWriteToolName(item.toolName)) {
      const path = readToolPath(item.input);
      if (path) {
        rememberTempFile(byKey, {
          path,
          itemId: item.id,
          toolName: item.toolName ?? null,
        });
      }
    }
  }

  return [...byKey.values()];
}
