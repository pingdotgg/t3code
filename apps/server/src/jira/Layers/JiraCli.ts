import { Effect, Layer } from "effect";

import { runProcess } from "../../processRunner";
import { JiraCliError } from "../Errors.ts";
import { JiraCli, type JiraCliShape } from "../Services/JiraCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeJiraCliError(operation: string, error: unknown): JiraCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: jira")) {
      return new JiraCliError({
        operation,
        detail: "Jira CLI (`jira`) is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("login first")
    ) {
      return new JiraCliError({
        operation,
        detail: "Jira CLI is not authenticated. Run `jira init` and retry.",
        cause: error,
      });
    }

    if (lower.includes("not found") || lower.includes("does not exist")) {
      return new JiraCliError({
        operation,
        detail: "Jira issue not found. Check the issue key and try again.",
        cause: error,
      });
    }

    return new JiraCliError({
      operation,
      detail: `Jira CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new JiraCliError({
    operation,
    detail: "Jira CLI command failed.",
    cause: error,
  });
}

function parseIssueKeyFromStdout(stdout: string): string | null {
  const match = /([A-Z][A-Z0-9]+-\d+)/.exec(stdout);
  return match?.[1] ?? null;
}

function parseJsonSafe(raw: string, operation: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`Jira CLI returned empty response for ${operation}.`);
  }
  return JSON.parse(trimmed);
}

const makeJiraCli = Effect.sync(() => {
  const execute: JiraCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runProcess("jira", input.args, {
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
      catch: (error) => normalizeJiraCliError("execute", error),
    });

  const service = {
    execute,

    viewIssue: (input) =>
      execute({
        args: ["issue", "view", input.key, "--raw"],
      }).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => {
              const parsed = parseJsonSafe(result.stdout, "viewIssue") as Record<string, any>;
              const fields = (parsed.fields ?? {}) as Record<string, any>;
              return {
                key: String(parsed.key ?? input.key),
                url: String(parsed.url ?? ""),
                summary: String(parsed.summary ?? fields.summary ?? ""),
                status: String(parsed.status ?? fields.status?.name ?? "Unknown"),
                type: String(parsed.type ?? fields.issuetype?.name ?? "Task"),
                priority: String(parsed.priority ?? fields.priority?.name ?? "Medium"),
                description: String(parsed.description ?? fields.description ?? ""),
              };
            },
            catch: (error: unknown) =>
              new JiraCliError({
                operation: "viewIssue",
                detail:
                  error instanceof Error
                    ? `Failed to parse Jira issue: ${error.message}`
                    : "Failed to parse Jira issue response.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      ),

    createIssue: (input) =>
      execute({
        args: [
          "issue",
          "create",
          "--project",
          input.projectKey,
          "--type",
          input.type,
          "--priority",
          input.priority,
          "--summary",
          input.summary,
          "--description",
          input.description,
          "--no-input",
        ],
      }).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => {
              const key = parseIssueKeyFromStdout(result.stdout);
              if (!key) {
                throw new Error("Could not extract issue key from Jira CLI output.");
              }
              return {
                key,
                url: "",
              };
            },
            catch: (error: unknown) =>
              new JiraCliError({
                operation: "createIssue",
                detail:
                  error instanceof Error
                    ? `Failed to parse create result: ${error.message}`
                    : "Failed to parse Jira create issue response.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      ),

    moveIssue: (input) =>
      execute({
        args: ["issue", "move", input.key, input.targetStatus],
      }).pipe(
        Effect.map(() => ({
          key: input.key,
          newStatus: input.targetStatus,
        })),
      ),

    addComment: (input) =>
      execute({
        args: ["issue", "comment", "add", input.key, input.comment],
      }).pipe(
        Effect.map(() => ({
          key: input.key,
        })),
      ),

    listIssues: (input) =>
      execute({
        args: [
          "issue",
          "list",
          ...(input.projectKey ? ["--project", input.projectKey] : []),
          ...(input.jql ? ["--jql", input.jql] : []),
          "--raw",
        ],
      }).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => {
              const parsed = parseJsonSafe(result.stdout, "listIssues");
              const items = Array.isArray(parsed) ? parsed : [];
              return {
                issues: items.map((item: Record<string, any>) => {
                  const fields = (item.fields ?? {}) as Record<string, any>;
                  return {
                    key: String(item.key ?? ""),
                    summary: String(item.summary ?? fields.summary ?? ""),
                    status: String(item.status ?? fields.status?.name ?? "Unknown"),
                    type: String(item.type ?? fields.issuetype?.name ?? "Task"),
                  };
                }),
              };
            },
            catch: (error: unknown) =>
              new JiraCliError({
                operation: "listIssues",
                detail:
                  error instanceof Error
                    ? `Failed to parse issue list: ${error.message}`
                    : "Failed to parse Jira issue list response.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      ),
  } satisfies JiraCliShape;

  return service;
});

export const JiraCliLive = Layer.effect(JiraCli, makeJiraCli);
