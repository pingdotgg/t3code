import type { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ProjectService from "../project/ProjectService.ts";
import { MentionIndex, mentionIndexScopeKey, type MentionIndexRow } from "./MentionIndex.ts";
import { MentionIndexMcpClient, MentionIndexMcpError } from "./MentionIndexMcpClient.ts";

const STALE_AFTER_MS = 15 * 60 * 1_000;
const MAX_ROWS = 500;

export class MentionIndexJiraSyncer extends Context.Service<
  MentionIndexJiraSyncer,
  {
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<void>;
    readonly syncProject: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/mention/MentionIndexJiraSyncer") {}

const make = Effect.gen(function* () {
  const index = yield* MentionIndex;
  const mcp = yield* MentionIndexMcpClient;
  const projects = yield* ProjectService.ProjectService;
  const inFlight = yield* Ref.make(new Set<string>());

  const syncProject = Effect.fn("MentionIndexJiraSyncer.syncProject")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("jira", projectId);
    yield* index.markSyncing(scopeKey);

    const settings = yield* mcp.readSettings;
    const jiraSettings = settings.jira;
    const project = yield* projects.getById(projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    const server = yield* mcp.resolveServer({
      kind: "jira",
      ...(project?.workspaceRoot !== undefined ? { projectRoot: project.workspaceRoot } : {}),
      ...(jiraSettings?.serverName !== undefined ? { serverName: jiraSettings.serverName } : {}),
    });
    if (server === null) {
      yield* index.replaceScope(scopeKey, [], {
        status: "empty",
        detail: "No Jira MCP server configured",
      });
      return;
    }

    const synced = yield* Effect.result(
      mcp.withSession(server, (session) =>
        Effect.gen(function* () {
          const tools = yield* session.listTools();
          const names = new Set(tools.map((tool) => tool.name));
          const spaces = jiraSettings?.spaces ?? [];
          const jqlBase =
            spaces.length > 0
              ? `project in (${spaces.map((space) => JSON.stringify(space)).join(", ")})`
              : "updated >= -90d";
          const jqlExtra = jiraSettings?.jqlExtra?.trim();
          const jql = `${jqlBase}${jqlExtra ? ` AND (${jqlExtra})` : ""} ORDER BY updated DESC`;

          let payload: unknown;
          if (names.has("searchJiraIssuesUsingJql")) {
            payload = yield* session.callTool("searchJiraIssuesUsingJql", {
              jql,
              maxResults: MAX_ROWS,
            });
          } else if (names.has("search") || names.has("jira_search")) {
            const tool = names.has("search") ? "search" : "jira_search";
            payload = yield* session.callTool(tool, { jql, maxResults: MAX_ROWS });
          } else if (names.has("executeRead") && names.has("discover")) {
            yield* session.callTool("discover", {});
            payload = yield* session.callTool("executeRead", {
              query: jql,
              maxResults: MAX_ROWS,
            });
          } else {
            return yield* Effect.fail(
              new MentionIndexMcpError(
                "Jira MCP server has no searchable issue tool (expected searchJiraIssuesUsingJql)",
              ),
            );
          }

          const now = yield* Clock.currentTimeMillis;
          return extractJiraRows(payload, now).slice(0, MAX_ROWS);
        }),
      ),
    );

    if (Result.isFailure(synced)) {
      const detail = synced.failure.message;
      yield* index.markError(scopeKey, detail);
      yield* Effect.logWarning("Mention index Jira sync failed", {
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

  const ensureIndexed = Effect.fn("MentionIndexJiraSyncer.ensureIndexed")(function* (
    projectId: ProjectId,
  ) {
    const scopeKey = mentionIndexScopeKey("jira", projectId);
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

  return MentionIndexJiraSyncer.of({ ensureIndexed, syncProject });
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

export function extractJiraRows(payload: unknown, now: number): MentionIndexRow[] {
  const root = textFromMcpResult(payload);
  const issues =
    (Array.isArray(root)
      ? root
      : Array.isArray(asRecord(root)?.issues)
        ? (asRecord(root)?.issues as unknown[])
        : Array.isArray(asRecord(root)?.results)
          ? (asRecord(root)?.results as unknown[])
          : []) ?? [];

  const rows: MentionIndexRow[] = [];
  for (const issue of issues) {
    const record = asRecord(issue);
    if (record === null) continue;
    const fields = asRecord(record.fields) ?? {};
    const key = stringOf(record.key) ?? stringOf(record.issueKey);
    if (key === undefined) continue;
    const summary =
      stringOf(fields.summary) ?? stringOf(record.summary) ?? stringOf(record.title) ?? key;
    const status = stringOf(asRecord(fields.status)?.name) ?? stringOf(record.status) ?? undefined;
    const projectKey =
      stringOf(asRecord(fields.project)?.key) ?? stringOf(record.projectKey) ?? key.split("-")[0];
    const url =
      stringOf(record.url) ??
      stringOf(record.webUrl) ??
      stringOf(asRecord(record.fields)?.url) ??
      (projectKey ? `https://atlassian.net/browse/${key}` : `https://atlassian.net/browse/${key}`);
    rows.push({
      providerId: "jira",
      itemKey: key,
      label: key,
      description: summary.slice(0, 500),
      url: url.slice(0, 2_048),
      tokens: foldTokens([key, summary, projectKey ?? "", status ?? ""]),
      jira: {
        key,
        summary: summary.slice(0, 500),
        url: url.slice(0, 2_048),
        ...(projectKey !== undefined ? { projectKey } : {}),
        ...(status !== undefined ? { status } : {}),
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

export const layer = Layer.effect(MentionIndexJiraSyncer, make);
