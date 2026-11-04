import type { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import { MentionIndex, mentionIndexScopeKey, type MentionIndexRow } from "./MentionIndex.ts";
import { MentionIndexMcpClient, MentionIndexMcpError } from "./MentionIndexMcpClient.ts";

const STALE_AFTER_MS = 15 * 60 * 1_000;
const MAX_ROWS = 500;

export class MentionIndexFigmaSyncer extends Context.Service<
  MentionIndexFigmaSyncer,
  {
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<void>;
    readonly syncProject: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/mention/MentionIndexFigmaSyncer") {}

const make = Effect.gen(function* () {
  const index = yield* MentionIndex;
  const mcp = yield* MentionIndexMcpClient;
  const inFlight = yield* Ref.make(new Set<string>());

  const syncProject = Effect.fn("MentionIndexFigmaSyncer.syncProject")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("figma", projectId);
    yield* index.markSyncing(scopeKey);

    const settings = yield* mcp.readSettings;
    const figmaSettings = settings.figma;
    const fileKeys = figmaSettings?.fileKeys ?? [];
    const server = yield* mcp.resolveServer({
      kind: "figma",
      ...(figmaSettings?.serverName !== undefined ? { serverName: figmaSettings.serverName } : {}),
    });
    if (server === null) {
      yield* index.replaceScope(scopeKey, [], {
        status: "empty",
        detail: "No Figma MCP server configured",
      });
      return;
    }
    if (fileKeys.length === 0) {
      yield* index.replaceScope(scopeKey, [], {
        status: "empty",
        detail: "No Figma fileKeys configured in mentionIndex.figma",
      });
      return;
    }

    const synced = yield* Effect.result(
      mcp.withSession(server, (session) =>
        Effect.gen(function* () {
          const tools = yield* session.listTools();
          const names = new Set(tools.map((tool) => tool.name));
          const hasMetadata = names.has("get_metadata");
          const hasFigmaData = names.has("get_figma_data");
          if (!hasMetadata && !hasFigmaData) {
            return yield* Effect.fail(
              new MentionIndexMcpError(
                "Figma MCP server has neither get_metadata nor get_figma_data",
              ),
            );
          }

          const now = yield* Clock.currentTimeMillis;
          const rows: MentionIndexRow[] = [];
          for (const fileKey of fileKeys.slice(0, 50)) {
            const payload = hasMetadata
              ? yield* session.callTool("get_metadata", { fileKey })
              : yield* session.callTool("get_figma_data", { fileKey });
            if (mcpResultIsError(payload)) {
              return yield* Effect.fail(
                new MentionIndexMcpError(
                  mcpResultErrorMessage(payload) ??
                    `Figma MCP tool returned isError for file ${fileKey}`,
                ),
              );
            }
            rows.push(...extractFigmaRows(fileKey, payload, now));
            if (rows.length >= MAX_ROWS) break;
          }
          return rows.slice(0, MAX_ROWS);
        }),
      ),
    );

    if (Result.isFailure(synced)) {
      const detail = synced.failure.message;
      yield* index.markError(scopeKey, detail);
      yield* Effect.logWarning("Mention index Figma sync failed", {
        projectId,
        cause: synced.failure,
      });
      return;
    }

    const syncedAt = yield* Clock.currentTimeMillis;
    yield* index.replaceScope(scopeKey, synced.success, {
      status: synced.success.length === 0 ? "empty" : "ready",
      syncedAt,
    });
  });

  const ensureIndexed = Effect.fn("MentionIndexFigmaSyncer.ensureIndexed")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("figma", projectId);
    const meta = yield* index.scopeMeta(scopeKey);
    const now = yield* Clock.currentTimeMillis;
    const stale =
      meta === null ||
      meta.status === "empty" ||
      meta.status === "error" ||
      now - meta.syncedAt > STALE_AFTER_MS;
    if (!stale) return;

    const key = String(projectId);
    const running = yield* Ref.get(inFlight);
    if (running.has(key)) return;

    yield* Ref.update(inFlight, (set) => new Set(set).add(key));
    yield* syncProject(projectId).pipe(
      Effect.ensuring(
        Ref.update(inFlight, (set) => {
          const next = new Set(set);
          next.delete(key);
          return next;
        }),
      ),
      Effect.forkDetach,
      Effect.asVoid,
    );
  });

  return MentionIndexFigmaSyncer.of({ ensureIndexed, syncProject });
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function mcpResultIsError(payload: unknown): boolean {
  const record = asRecord(payload);
  return record !== null && record.isError === true;
}

function mcpResultErrorMessage(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record === null) return undefined;
  const content = record.content;
  if (!Array.isArray(content)) return stringOf(record.message);
  const texts = content.flatMap((entry) => {
    const item = asRecord(entry);
    const text = item === null ? undefined : stringOf(item.text);
    return text === undefined ? [] : [text];
  });
  return texts[0] ?? stringOf(record.message);
}

function textFromMcpResult(payload: unknown): unknown {
  const record = asRecord(payload);
  if (record === null) return payload;
  if (record.structuredContent !== undefined) return record.structuredContent;
  const content = record.content;
  if (!Array.isArray(content)) return payload;
  const texts = content.flatMap((entry) => {
    const item = asRecord(entry);
    const text = item === null ? undefined : stringOf(item.text);
    return text === undefined ? [] : [text];
  });
  if (texts.length === 0) return payload;
  const joined = texts.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

/** Lightweight extract of name/id from page-like XML nodes in get_metadata text. */
export function pagesFromFigmaXml(xml: string): ReadonlyArray<{ id: string; name: string }> {
  const pages: Array<{ id: string; name: string }> = [];
  const tagRe = /<(canvas|page)\b([^>]*)\/?>/giu;
  for (const match of xml.matchAll(tagRe)) {
    const attrs = match[2] ?? "";
    const id =
      attrs.match(/\bid\s*=\s*"([^"]+)"/iu)?.[1] ?? attrs.match(/\bid\s*=\s*'([^']+)'/iu)?.[1];
    const name =
      attrs.match(/\bname\s*=\s*"([^"]+)"/iu)?.[1] ?? attrs.match(/\bname\s*=\s*'([^']+)'/iu)?.[1];
    if (id === undefined || name === undefined) continue;
    pages.push({ id, name });
  }
  return pages;
}

export function extractFigmaRows(
  fileKey: string,
  payload: unknown,
  now: number,
): MentionIndexRow[] {
  const root = textFromMcpResult(payload);
  const record = asRecord(root) ?? {};
  const name =
    stringOf(record.name) ?? stringOf(record.fileName) ?? stringOf(record.title) ?? fileKey;
  const url = `https://www.figma.com/design/${fileKey}`;
  const rows: MentionIndexRow[] = [
    {
      providerId: "figma",
      itemKey: fileKey,
      label: name.slice(0, 200),
      description: name.slice(0, 500),
      url,
      tokens: foldTokens([fileKey, name]),
      figma: {
        fileKey,
        name: name.slice(0, 500),
        url,
      },
      updatedAt: now,
    },
  ];

  const structuredPages =
    (Array.isArray(record.pages)
      ? record.pages
      : Array.isArray(asRecord(record.document)?.children)
        ? (asRecord(record.document)?.children as unknown[])
        : Array.isArray(record.nodes)
          ? (record.nodes as unknown[])
          : []) ?? [];

  const xmlPages =
    structuredPages.length === 0 && typeof root === "string" ? pagesFromFigmaXml(root) : [];

  const pages =
    structuredPages.length > 0
      ? structuredPages
      : xmlPages.map((page) => ({ id: page.id, name: page.name }));

  for (const page of pages.slice(0, 40)) {
    const pageRecord = asRecord(page);
    if (pageRecord === null) continue;
    const pageName = stringOf(pageRecord.name) ?? stringOf(pageRecord.title);
    const nodeId =
      stringOf(pageRecord.id) ?? stringOf(pageRecord.nodeId) ?? stringOf(pageRecord.key);
    if (pageName === undefined || nodeId === undefined) continue;
    const pageUrl = `${url}?node-id=${encodeURIComponent(nodeId)}`;
    rows.push({
      providerId: "figma",
      itemKey: `${fileKey}:${nodeId}`,
      label: pageName.slice(0, 200),
      description: `${name} · ${pageName}`.slice(0, 500),
      url: pageUrl.slice(0, 2_048),
      tokens: foldTokens([fileKey, name, pageName, nodeId]),
      figma: {
        fileKey,
        name: pageName.slice(0, 500),
        url: pageUrl.slice(0, 2_048),
        nodeId,
      },
      updatedAt: now,
    });
  }

  return rows;
}

function foldTokens(parts: ReadonlyArray<string>): string {
  return parts
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

export const layer = Layer.effect(MentionIndexFigmaSyncer, make);
