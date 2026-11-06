import type {
  MentionIndexFigmaBrowseInput,
  MentionIndexFigmaBrowseTeamsResult,
  MentionIndexFigmaListProjectsInput,
  MentionIndexFigmaListProjectsResult,
  ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import {
  MentionIndex,
  mentionIndexScopeKey,
  mentionIndexThumbKey,
  type MentionIndexRow,
} from "./MentionIndex.ts";
import { MentionIndexMcpClient, MentionIndexMcpError } from "./MentionIndexMcpClient.ts";

const STALE_AFTER_MS = 15 * 60 * 1_000;
const MAX_ROWS = 50;

export class MentionIndexFigmaSyncer extends Context.Service<
  MentionIndexFigmaSyncer,
  {
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<void>;
    readonly syncProject: (projectId: ProjectId) => Effect.Effect<void>;
    /** Always fetch one file by key and write it through into the index. */
    readonly ensureExact: (projectId: ProjectId, fileKey: string) => Effect.Effect<void>;
    readonly listTeams: (
      input: MentionIndexFigmaBrowseInput,
    ) => Effect.Effect<MentionIndexFigmaBrowseTeamsResult>;
    readonly listProjects: (
      input: MentionIndexFigmaListProjectsInput,
    ) => Effect.Effect<MentionIndexFigmaListProjectsResult>;
  }
>()("t3/mention/MentionIndexFigmaSyncer") {}

const make = Effect.gen(function* () {
  const index = yield* MentionIndex;
  const mcp = yield* MentionIndexMcpClient;
  const inFlight = yield* Ref.make(new Set<string>());
  const exactInFlight = yield* Ref.make(new Set<string>());

  const resolveFigmaServer = Effect.fn("MentionIndexFigmaSyncer.resolveFigmaServer")(
    function* (input: {
      readonly projectId?: ProjectId | undefined;
      readonly serverName?: string | undefined;
    }) {
      const settings = yield* mcp.readSettings(input.projectId ?? null);
      const serverName = input.serverName?.trim() || settings.figma?.serverName;
      return yield* mcp.resolveServer({
        kind: "figma",
        ...(serverName !== undefined && serverName.length > 0 ? { serverName } : {}),
      });
    },
  );

  const listTeams = Effect.fn("MentionIndexFigmaSyncer.listTeams")(function* (
    input: MentionIndexFigmaBrowseInput,
  ) {
    const server = yield* resolveFigmaServer(input);
    if (server === null) {
      return {
        teams: [],
        detail:
          "No Figma MCP server found. Add one in Cursor/Claude/Codex MCP settings (needs list_teams).",
      } satisfies MentionIndexFigmaBrowseTeamsResult;
    }

    const listed = yield* Effect.result(
      mcp.withSession(server, (session) =>
        Effect.gen(function* () {
          const tools = yield* session.listTools();
          const names = new Set(tools.map((tool) => tool.name));
          if (!names.has("list_teams")) {
            return yield* new MentionIndexMcpError({
              detail:
                "Figma MCP has no list_teams tool. Use a REST-based Figma MCP (e.g. figma-rest-mcp).",
            });
          }
          const payload = yield* session.callTool("list_teams", {});
          return extractNamedIds(payload, ["teams", "team"]).slice(0, 100);
        }),
      ),
    );

    if (Result.isFailure(listed)) {
      return { teams: [], detail: listed.failure.message.slice(0, 500) };
    }
    return {
      teams: listed.success,
      ...(listed.success.length === 0
        ? { detail: "No Figma teams returned for this account." }
        : {}),
    };
  });

  const listProjects = Effect.fn("MentionIndexFigmaSyncer.listProjects")(function* (
    input: MentionIndexFigmaListProjectsInput,
  ) {
    const server = yield* resolveFigmaServer(input);
    if (server === null) {
      return {
        projects: [],
        detail: "No Figma MCP server found.",
      } satisfies MentionIndexFigmaListProjectsResult;
    }

    const listed = yield* Effect.result(
      mcp.withSession(server, (session) =>
        Effect.gen(function* () {
          const tools = yield* session.listTools();
          const names = new Set(tools.map((tool) => tool.name));
          if (!names.has("list_projects")) {
            return yield* new MentionIndexMcpError({
              detail:
                "Figma MCP has no list_projects tool. Use a REST-based Figma MCP (e.g. figma-rest-mcp).",
            });
          }
          const payload = yield* session.callTool("list_projects", { team_id: input.teamId });
          return extractNamedIds(payload, ["projects", "project"]).slice(0, 200);
        }),
      ),
    );

    if (Result.isFailure(listed)) {
      return { projects: [], detail: listed.failure.message.slice(0, 500) };
    }
    return {
      projects: listed.success,
      ...(listed.success.length === 0 ? { detail: "No Figma projects in this team." } : {}),
    };
  });

  const syncProject = Effect.fn("MentionIndexFigmaSyncer.syncProject")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("figma", projectId);
    yield* index.markSyncing(scopeKey);

    const settings = yield* mcp.readSettings(projectId);
    const figmaSettings = settings.figma;
    const configuredProjects = figmaSettings?.projects ?? [];
    const pastedKeys = figmaSettings?.fileKeys ?? [];
    if (configuredProjects.length === 0 && pastedKeys.length === 0) {
      yield* index.replaceScope(scopeKey, [], {
        status: "empty",
        detail: "No Figma projects or files configured in Settings → Chat → Mentions",
      });
      return;
    }

    const server = yield* mcp.resolveServer({
      kind: "figma",
      ...(figmaSettings?.serverName !== undefined ? { serverName: figmaSettings.serverName } : {}),
    });

    const synced = yield* Effect.result(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (server === null) {
          return pastedKeys.map((fileKey) =>
            figmaRow({
              fileKey,
              name: fileKey,
              now,
              hasThumbnail: false,
            }),
          );
        }

        return yield* mcp.withSession(server, (session) =>
          Effect.gen(function* () {
            const tools = yield* session.listTools();
            const names = new Set(tools.map((tool) => tool.name));
            const fileEntries = new Map<string, { readonly name: string; readonly url?: string }>();

            for (const key of pastedKeys) {
              fileEntries.set(key, { name: key });
            }

            if (configuredProjects.length > 0) {
              const listTool = names.has("list_files")
                ? "list_files"
                : names.has("list_project_files")
                  ? "list_project_files"
                  : null;
              if (listTool === null) {
                return yield* new MentionIndexMcpError({
                  detail:
                    "Figma MCP cannot list project files (needs list_files or list_project_files).",
                });
              }
              for (const project of configuredProjects) {
                const listed = yield* Effect.result(
                  session.callTool(listTool, { project_id: project.id }),
                );
                if (Result.isFailure(listed)) continue;
                for (const file of extractFigmaFiles(listed.success)) {
                  if (fileEntries.has(file.key)) continue;
                  fileEntries.set(file.key, {
                    name: file.name,
                    ...(file.url !== undefined ? { url: file.url } : {}),
                  });
                }
              }
            }

            const rows: MentionIndexRow[] = [];
            for (const [fileKey, meta] of [...fileEntries.entries()].slice(0, MAX_ROWS)) {
              const url = meta.url ?? `https://www.figma.com/design/${fileKey}`;
              let name = meta.name;
              let hasThumbnail = false;

              if (names.has("get_metadata")) {
                const metaResult = yield* Effect.result(
                  session.callTool("get_metadata", {
                    fileKey,
                    clientLanguages: "unknown",
                    clientFrameworks: "unknown",
                  }),
                );
                if (Result.isSuccess(metaResult)) {
                  name = extractFigmaName(metaResult.success, fileKey) ?? name;
                }
              }

              if (names.has("get_screenshot")) {
                const shot = yield* Effect.result(
                  session.callTool("get_screenshot", {
                    fileKey,
                    clientLanguages: "unknown",
                    clientFrameworks: "unknown",
                  }),
                );
                if (Result.isSuccess(shot)) {
                  const image = extractMcpImage(shot.success);
                  if (image !== null) {
                    yield* index.putThumbnail(mentionIndexThumbKey("figma", projectId, fileKey), {
                      mimeType: image.mimeType,
                      dataBase64: image.dataBase64,
                    });
                    hasThumbnail = true;
                  }
                }
              }

              rows.push(
                figmaRow({
                  fileKey,
                  name,
                  url,
                  now,
                  hasThumbnail,
                }),
              );
            }

            if (rows.length === 0) {
              return yield* new MentionIndexMcpError({
                detail: "Figma MCP returned no files for configured projects",
              });
            }
            return rows;
          }),
        );
      }),
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
    const freshnessMs =
      meta !== null && (meta.status === "empty" || meta.status === "error")
        ? 30_000
        : STALE_AFTER_MS;
    const stale = meta === null || now - meta.syncedAt > freshnessMs;
    if (!stale) return;

    const key = String(projectId);
    const claimed = yield* Ref.modify(inFlight, (set) => {
      if (set.has(key)) return [false, set] as const;
      const next = new Set(set);
      next.add(key);
      return [true, next] as const;
    });
    if (!claimed) return;

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

  const ensureExact = Effect.fn("MentionIndexFigmaSyncer.ensureExact")(function* (
    projectId: ProjectId,
    fileKey: string,
  ) {
    const flightKey = `${projectId}:${fileKey}`;
    const claimed = yield* Ref.modify(exactInFlight, (set) => {
      if (set.has(flightKey)) return [false, set] as const;
      const next = new Set(set);
      next.add(flightKey);
      return [true, next] as const;
    });
    if (!claimed) return;

    yield* Effect.gen(function* () {
      const server = yield* resolveFigmaServer({ projectId });
      const now = yield* Clock.currentTimeMillis;
      if (server === null) {
        yield* index.upsertRows(mentionIndexScopeKey("figma", projectId), [
          figmaRow({ fileKey, name: fileKey, now, hasThumbnail: false }),
        ]);
        return;
      }

      const fetched = yield* Effect.result(
        mcp.withSession(server, (session) =>
          Effect.gen(function* () {
            const tools = yield* session.listTools();
            const names = new Set(tools.map((tool) => tool.name));
            let name = fileKey;
            let hasThumbnail = false;

            if (names.has("get_metadata")) {
              const metaResult = yield* Effect.result(
                session.callTool("get_metadata", {
                  fileKey,
                  clientLanguages: "unknown",
                  clientFrameworks: "unknown",
                }),
              );
              if (Result.isSuccess(metaResult)) {
                name = extractFigmaName(metaResult.success, fileKey) ?? name;
              }
            }

            if (names.has("get_screenshot")) {
              const shot = yield* Effect.result(
                session.callTool("get_screenshot", {
                  fileKey,
                  clientLanguages: "unknown",
                  clientFrameworks: "unknown",
                }),
              );
              if (Result.isSuccess(shot)) {
                const image = extractMcpImage(shot.success);
                if (image !== null) {
                  yield* index.putThumbnail(mentionIndexThumbKey("figma", projectId, fileKey), {
                    mimeType: image.mimeType,
                    dataBase64: image.dataBase64,
                  });
                  hasThumbnail = true;
                }
              }
            }

            return figmaRow({ fileKey, name, now, hasThumbnail });
          }),
        ),
      );

      if (Result.isFailure(fetched)) {
        yield* Effect.logWarning("Mention index exact Figma fetch failed", {
          projectId,
          fileKey,
          cause: fetched.failure,
        });
        yield* index.upsertRows(mentionIndexScopeKey("figma", projectId), [
          figmaRow({ fileKey, name: fileKey, now, hasThumbnail: false }),
        ]);
        return;
      }
      yield* index.upsertRows(mentionIndexScopeKey("figma", projectId), [fetched.success]);
    }).pipe(
      Effect.ensuring(
        Ref.update(exactInFlight, (set) => {
          const next = new Set(set);
          next.delete(flightKey);
          return next;
        }),
      ),
    );
  });

  return MentionIndexFigmaSyncer.of({
    ensureIndexed,
    syncProject,
    ensureExact,
    listTeams,
    listProjects,
  });
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function figmaRow(input: {
  readonly fileKey: string;
  readonly name: string;
  readonly url?: string;
  readonly now: number;
  readonly hasThumbnail: boolean;
}): MentionIndexRow {
  const url = (input.url ?? `https://www.figma.com/design/${input.fileKey}`).slice(0, 2_048);
  const name = input.name.slice(0, 500);
  return {
    providerId: "figma",
    itemKey: input.fileKey,
    label: name.slice(0, 200),
    description: "Figma design",
    url,
    tokens: foldTokens([name, input.fileKey]),
    figma: {
      fileKey: input.fileKey,
      name,
      url,
      hasThumbnail: input.hasThumbnail,
    },
    updatedAt: input.now,
  };
}

function foldTokens(parts: ReadonlyArray<string>): string {
  return parts
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

/** Pull a display name from get_metadata XML/text or structured payload. */
function extractFigmaName(payload: unknown, fallback: string): string | undefined {
  const record = asRecord(payload);
  if (record !== null) {
    const direct =
      stringOf(record.name) ??
      stringOf(record.title) ??
      stringOf(record.fileName) ??
      stringOf(asRecord(record.meta)?.name);
    if (direct !== undefined) return direct.slice(0, 500);

    const content = record.content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        const text = stringOf(asRecord(entry)?.text);
        if (text === undefined) continue;
        const named = /name=["']([^"']+)["']/iu.exec(text)?.[1];
        if (named) return named.slice(0, 500);
        const heading = /^#\s+(.+)$/mu.exec(text)?.[1];
        if (heading) return heading.trim().slice(0, 500);
      }
    }
  }
  if (typeof payload === "string") {
    const named = /name=["']([^"']+)["']/iu.exec(payload)?.[1];
    if (named) return named.slice(0, 500);
  }
  void fallback;
  return undefined;
}

export function extractMcpImage(
  payload: unknown,
): { readonly mimeType: string; readonly dataBase64: string } | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const content = record.content;
  if (!Array.isArray(content)) return null;
  for (const entry of content) {
    const item = asRecord(entry);
    if (item === null) continue;
    if (stringOf(item.type) !== "image") continue;
    const data = stringOf(item.data) ?? stringOf(item.dataBase64);
    const mimeType = stringOf(item.mimeType) ?? "image/png";
    if (data === undefined || data.length === 0) continue;
    return { mimeType, dataBase64: data };
  }
  return null;
}

function mcpTextBlobs(payload: unknown): string[] {
  const blobs: string[] = [];
  if (typeof payload === "string" && payload.trim().length > 0) {
    blobs.push(payload);
    return blobs;
  }
  const record = asRecord(payload);
  if (record === null) return blobs;
  const content = record.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      const text = stringOf(asRecord(entry)?.text);
      if (text !== undefined) blobs.push(text);
    }
  }
  return blobs;
}

function tryParseJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function namedIdFromRecord(record: Record<string, unknown>): { id: string; name: string } | null {
  const id =
    stringOf(record.id) ??
    stringOf(record.team_id) ??
    stringOf(record.project_id) ??
    stringOf(record.key);
  if (id === undefined) return null;
  const name = stringOf(record.name) ?? stringOf(record.title) ?? stringOf(record.label) ?? id;
  return { id: id.slice(0, 128), name: name.slice(0, 256) };
}

function collectNamedIds(
  value: unknown,
  arrayKeys: ReadonlyArray<string>,
  out: Array<{ id: string; name: string }>,
  seen: Set<string>,
): void {
  if (out.length >= 200) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNamedIds(entry, arrayKeys, out, seen);
      if (out.length >= 200) return;
    }
    return;
  }
  const record = asRecord(value);
  if (record === null) return;
  const self = namedIdFromRecord(record);
  if (self !== null && !seen.has(self.id)) {
    // Prefer array-key children when present; still accept a lone object.
    const hasArrayChild = arrayKeys.some((key) => Array.isArray(record[key]));
    if (!hasArrayChild) {
      seen.add(self.id);
      out.push(self);
    }
  }
  for (const key of arrayKeys) {
    const child = record[key];
    if (child !== undefined) collectNamedIds(child, arrayKeys, out, seen);
  }
  // Some MCP tools nest under `data` / `result`.
  for (const key of ["data", "result", "body"] as const) {
    if (record[key] !== undefined) collectNamedIds(record[key], arrayKeys, out, seen);
  }
}

/** Parse MCP list_teams / list_projects payloads (JSON text or structured). */
export function extractNamedIds(
  payload: unknown,
  arrayKeys: ReadonlyArray<string>,
): ReadonlyArray<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  collectNamedIds(payload, arrayKeys, out, seen);
  for (const blob of mcpTextBlobs(payload)) {
    const parsed = tryParseJson(blob);
    if (parsed !== null) collectNamedIds(parsed, arrayKeys, out, seen);
    // Fallback: "Name (1234567890)" lines from text tools.
    for (const match of blob.matchAll(/^(.+?)\s*\((\d+)\)\s*$/gmu)) {
      const name = match[1]?.trim();
      const id = match[2];
      if (!name || !id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id: id.slice(0, 128), name: name.slice(0, 256) });
    }
  }
  return out;
}

export function extractFigmaFiles(
  payload: unknown,
): ReadonlyArray<{ readonly key: string; readonly name: string; readonly url?: string }> {
  const out: Array<{ key: string; name: string; url?: string }> = [];
  const seen = new Set<string>();

  const push = (record: Record<string, unknown>) => {
    const key =
      stringOf(record.key) ??
      stringOf(record.file_key) ??
      stringOf(record.fileKey) ??
      stringOf(record.id);
    if (key === undefined || seen.has(key)) return;
    const name = stringOf(record.name) ?? stringOf(record.title) ?? key;
    const url = stringOf(record.url) ?? stringOf(record.thumbnail_url);
    seen.add(key);
    out.push({
      key: key.slice(0, 128),
      name: name.slice(0, 500),
      ...(url !== undefined ? { url: url.slice(0, 2_048) } : {}),
    });
  };

  const walk = (value: unknown) => {
    if (out.length >= MAX_ROWS) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    const record = asRecord(value);
    if (record === null) return;
    if (
      stringOf(record.key) !== undefined ||
      stringOf(record.file_key) !== undefined ||
      stringOf(record.fileKey) !== undefined
    ) {
      push(record);
    }
    for (const key of ["files", "data", "result", "content"] as const) {
      if (record[key] !== undefined) walk(record[key]);
    }
  };

  walk(payload);
  for (const blob of mcpTextBlobs(payload)) {
    const parsed = tryParseJson(blob);
    if (parsed !== null) walk(parsed);
  }
  return out.slice(0, MAX_ROWS);
}

export const layer = Layer.effect(MentionIndexFigmaSyncer, make);
