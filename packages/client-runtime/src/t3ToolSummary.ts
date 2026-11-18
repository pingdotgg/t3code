import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { T3McpToolSummaryAction } from "@t3tools/shared/t3McpToolPresentation";

export interface T3ToolSummaryCall {
  readonly input: unknown;
  readonly output: unknown;
  readonly outcome: "completed" | "failed" | "unfinished";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface ToolResult {
  readonly data?: Record<string, unknown>;
  readonly failed: boolean;
}

function readResult(value: unknown, depth = 0): ToolResult {
  if (depth > 4) return { failed: false };
  if (typeof value === "string") {
    try {
      return readResult(JSON.parse(value), depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    let data: ToolResult["data"];
    let failed = false;
    for (const block of value) {
      const record = asRecord(block);
      const text = record?.text ?? asRecord(record?.content)?.text;
      const result = readResult(asRecord(text)?.text ?? text, depth + 1);
      data ??= result.data;
      failed ||= result.failed;
    }
    return { ...(data ? { data } : {}), failed };
  }
  const record = asRecord(value);
  if (!record) return { failed: false };
  const failed =
    record.isError === true ||
    record.is_error === true ||
    (typeof record._tag === "string" && /(?:Error|Failure)$/.test(record._tag)) ||
    record.error != null;
  const content = record.structuredContent ?? record.content;
  if (content !== undefined) {
    const result = readResult(content, depth + 1);
    return { ...(result.data ? { data: result.data } : {}), failed: failed || result.failed };
  }
  return { data: record, failed };
}

function readInput(value: unknown): Record<string, unknown> | undefined {
  const input = readResult(value).data;
  // Historical Cursor items retain the MCP args envelope.
  return input && typeof input.toolName === "string" ? asRecord(input.args) : input;
}

/** MCP errors can be returned as data even when the provider completed the tool call. */
export function t3ToolResultIndicatesFailure(output: unknown): boolean {
  return readResult(output).failed;
}

function countEntities(ids: ReadonlyArray<string | undefined>): number {
  return (
    new Set(ids.filter((value) => value !== undefined)).size +
    ids.filter((value) => value === undefined).length
  );
}

/** One PR per single call; a batch counts what its result reports. Null when a count was lost. */
function pullRequestCount(
  calls: ReadonlyArray<{
    readonly input: Record<string, unknown> | undefined;
    readonly output: Record<string, unknown> | undefined;
  }>,
  countKey: "linkedCount" | "unlinkedCount",
): number | null {
  let count = 0;
  for (const call of calls) {
    const reported = call.output?.[countKey];
    if (typeof reported === "number") count += reported;
    else if (call.input?.url !== undefined || call.input?.number !== undefined) count += 1;
    // A batch result too large to compact loses its count, so the label drops the number.
    else return null;
  }
  return count;
}

export function summarizeT3ToolCalls(
  action: T3McpToolSummaryAction,
  calls: ReadonlyArray<T3ToolSummaryCall>,
  resolve: MFunctionType = mFallback,
): { label: string; failedCount: number } {
  const results = calls.map((call) => {
    const result = readResult(call.output);
    return {
      input: readInput(call.input),
      output: result.data,
      outcome: result.failed ? ("failed" as const) : call.outcome,
    };
  });
  const completed = results.filter((call) => call.outcome === "completed");
  let failedCount = results.filter((call) => call.outcome === "failed").length;
  const done = completed.length > 0;
  const selected = done ? completed : results;
  const entityIds = (key: string) =>
    selected.map((call) => id(call.output?.[key]) ?? id(call.input?.[key]));
  const projectIds = selected.map(
    (call) => id(call.output?.id) ?? id(call.output?.projectId) ?? id(call.input?.projectId),
  );
  const threadIds = selected.map(
    (call) =>
      id(call.output?.threadId) ??
      id(asRecord(call.output?.thread)?.threadId) ??
      id(call.input?.threadId),
  );
  let label: string;
  switch (action) {
    case "delegate": {
      const count = countEntities(entityIds("taskId"));
      label = done
        ? resolve(
            msg("{count, plural, one {Delegated {count} task} other {Delegated {count} tasks}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to delegate {count} task} other {Tried to delegate {count} tasks}}",
              { count },
            ),
          );
      break;
    }
    case "thread-interrupt": {
      const count = countEntities(threadIds);
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Requested interrupts for {count} thread} other {Requested interrupts for {count} threads}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to interrupt {count} thread} other {Tried to interrupt {count} threads}}",
              { count },
            ),
          );
      break;
    }
    case "workflow-stop": {
      const count = countEntities(entityIds("subagentId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Requested stops for {count} workflow} other {Requested stops for {count} workflows}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to stop {count} workflow} other {Tried to stop {count} workflows}}",
              { count },
            ),
          );
      break;
    }
    case "task-cancel": {
      const count = countEntities(entityIds("taskId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Requested cancellation of {count} task} other {Requested cancellation of {count} tasks}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to cancel {count} task} other {Tried to cancel {count} tasks}}",
              { count },
            ),
          );
      break;
    }
    case "schedule-create": {
      const count = countEntities(entityIds("scheduledTaskId"));
      label = done
        ? resolve(
            msg("{count, plural, one {Scheduled {count} task} other {Scheduled {count} tasks}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to schedule {count} task} other {Tried to schedule {count} tasks}}",
              { count },
            ),
          );
      break;
    }
    case "schedule-update": {
      const count = countEntities(entityIds("scheduledTaskId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Updated {count} scheduled task} other {Updated {count} scheduled tasks}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to update {count} scheduled task} other {Tried to update {count} scheduled tasks}}",
              { count },
            ),
          );
      break;
    }
    case "schedule-delete": {
      const count = countEntities(entityIds("scheduledTaskId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Requested deletion of {count} scheduled task} other {Requested deletion of {count} scheduled tasks}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to delete {count} scheduled task} other {Tried to delete {count} scheduled tasks}}",
              { count },
            ),
          );
      break;
    }
    case "schedule-run": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Requested {count} scheduled task run} other {Requested {count} scheduled task runs}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to request {count} scheduled task run} other {Tried to request {count} scheduled task runs}}",
              { count },
            ),
          );
      break;
    }
    case "thread-fork": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Requested {count} thread fork} other {Requested {count} thread forks}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to request {count} thread fork} other {Tried to request {count} thread forks}}",
              { count },
            ),
          );
      break;
    }
    case "thread-merge": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Requested {count} context merge} other {Requested {count} context merges}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to request {count} context merge} other {Tried to request {count} context merges}}",
              { count },
            ),
          );
      break;
    }
    case "thread-update": {
      const count = countEntities(threadIds);
      label = done
        ? resolve(
            msg("{count, plural, one {Updated {count} thread} other {Updated {count} threads}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to update {count} thread} other {Tried to update {count} threads}}",
              { count },
            ),
          );
      break;
    }
    case "queue-read": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Read {count} queued message} other {Read {count} queued messages}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to read {count} queued message} other {Tried to read {count} queued messages}}",
              { count },
            ),
          );
      break;
    }
    case "queue-edit": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Edited {count} queued message} other {Edited {count} queued messages}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to edit {count} queued message} other {Tried to edit {count} queued messages}}",
              { count },
            ),
          );
      break;
    }
    case "queue-cancel": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Requested cancellation of {count} queued run} other {Requested cancellation of {count} queued runs}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to cancel {count} queued run} other {Tried to cancel {count} queued runs}}",
              { count },
            ),
          );
      break;
    }
    case "queue-reorder": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Reordered {count} queued run} other {Reordered {count} queued runs}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to reorder {count} queued run} other {Tried to reorder {count} queued runs}}",
              { count },
            ),
          );
      break;
    }
    case "queue-steer": {
      const count = countEntities(entityIds("queuedRunId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Requested steering with {count} queued message} other {Requested steering with {count} queued messages}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to steer with {count} queued message} other {Tried to steer with {count} queued messages}}",
              { count },
            ),
          );
      break;
    }
    case "question-read": {
      const count = countEntities(entityIds("requestId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Read {count} pending question request} other {Read {count} pending question requests}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to read {count} pending question request} other {Tried to read {count} pending question requests}}",
              { count },
            ),
          );
      break;
    }
    case "question-respond": {
      const count = countEntities(entityIds("requestId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Answered {count} pending question request} other {Answered {count} pending question requests}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to answer {count} pending question request} other {Tried to answer {count} pending question requests}}",
              { count },
            ),
          );
      break;
    }
    case "secret-request": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Asked for {count} secret} other {Asked for {count} secrets}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to ask for {count} secret} other {Tried to ask for {count} secrets}}",
              { count },
            ),
          );
      break;
    }
    case "worktree-handoff": {
      const count = countEntities(entityIds("worktreePath"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Handed off to {count} worktree} other {Handed off to {count} worktrees}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to hand off to {count} worktree} other {Tried to hand off to {count} worktrees}}",
              { count },
            ),
          );
      break;
    }
    case "project-read": {
      const count = countEntities(projectIds);
      label = done
        ? resolve(
            msg("{count, plural, one {Read {count} project} other {Read {count} projects}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to read {count} project} other {Tried to read {count} projects}}",
              { count },
            ),
          );
      break;
    }
    case "project-create": {
      const count = countEntities(projectIds);
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Registered {count} project} other {Registered {count} projects}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to register {count} project} other {Tried to register {count} projects}}",
              { count },
            ),
          );
      break;
    }
    case "project-update": {
      const count = countEntities(projectIds);
      label = done
        ? resolve(
            msg("{count, plural, one {Updated {count} project} other {Updated {count} projects}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to update {count} project} other {Tried to update {count} projects}}",
              { count },
            ),
          );
      break;
    }
    case "project-delete": {
      const count = countEntities(projectIds);
      label = done
        ? resolve(
            msg("{count, plural, one {Deleted {count} project} other {Deleted {count} projects}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to delete {count} project} other {Tried to delete {count} projects}}",
              { count },
            ),
          );
      break;
    }
    case "project-clone": {
      const count = countEntities(entityIds("cwd"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Cloned {count} repository} other {Cloned {count} repositories}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to clone {count} repository} other {Tried to clone {count} repositories}}",
              { count },
            ),
          );
      break;
    }
    case "environment-link": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Asked to link {count} environment} other {Asked to link {count} environments}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to ask to link {count} environment} other {Tried to ask to link {count} environments}}",
              { count },
            ),
          );
      break;
    }
    case "environment-unlink": {
      const count = countEntities(entityIds("environmentId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Forgot {count} linked environment} other {Forgot {count} linked environments}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to forget {count} linked environment} other {Tried to forget {count} linked environments}}",
              { count },
            ),
          );
      break;
    }
    case "attachment-prepare": {
      const count = countEntities(entityIds("attachmentId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Prepared {count} attachment upload} other {Prepared {count} attachment uploads}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to prepare {count} attachment upload} other {Tried to prepare {count} attachment uploads}}",
              { count },
            ),
          );
      break;
    }
    case "attachment-discard": {
      const count = countEntities(entityIds("attachmentId"));
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Discarded {count} pending attachment} other {Discarded {count} pending attachments}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to discard {count} pending attachment} other {Tried to discard {count} pending attachments}}",
              { count },
            ),
          );
      break;
    }
    case "watch-pr": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Watching {count} pull request} other {Watching {count} pull requests}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to watch {count} pull request} other {Tried to watch {count} pull requests}}",
              { count },
            ),
          );
      break;
    }
    case "unwatch-pr": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Stopped watching {count} pull request} other {Stopped watching {count} pull requests}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to stop watching {count} pull request} other {Tried to stop watching {count} pull requests}}",
              { count },
            ),
          );
      break;
    }
    case "read-pr-guide": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Read {count} review guide} other {Read {count} review guides}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to read {count} review guide} other {Tried to read {count} review guides}}",
              { count },
            ),
          );
      break;
    }
    case "list-issues": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Listed issues {count} time} other {Listed issues {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to list issues {count} time} other {Tried to list issues {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "read-issue": {
      const count = selected.length;
      label = done
        ? resolve(
            msg("{count, plural, one {Read {count} issue} other {Read {count} issues}}", { count }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to read {count} issue} other {Tried to read {count} issues}}",
              { count },
            ),
          );
      break;
    }
    case "create-issue": {
      const count = selected.length;
      label = done
        ? resolve(
            msg("{count, plural, one {Filed {count} issue} other {Filed {count} issues}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to file {count} issue} other {Tried to file {count} issues}}",
              { count },
            ),
          );
      break;
    }
    case "comment-issue": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Commented on {count} issue} other {Commented on {count} issues}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to comment on {count} issue} other {Tried to comment on {count} issues}}",
              { count },
            ),
          );
      break;
    }
    case "set-issue-state": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Changed the state of {count} issue} other {Changed the state of {count} issues}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to change the state of {count} issue} other {Tried to change the state of {count} issues}}",
              { count },
            ),
          );
      break;
    }
    case "link-issue": {
      const count = selected.length;
      label = done
        ? resolve(
            msg("{count, plural, one {Linked {count} issue} other {Linked {count} issues}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to link {count} issue} other {Tried to link {count} issues}}",
              { count },
            ),
          );
      break;
    }
    case "unlink-issue": {
      const count = selected.length;
      label = done
        ? resolve(
            msg("{count, plural, one {Unlinked {count} issue} other {Unlinked {count} issues}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to unlink {count} issue} other {Tried to unlink {count} issues}}",
              { count },
            ),
          );
      break;
    }
    case "list-thread-issues": {
      const count = selected.length;
      if (count === 1) {
        label = done
          ? resolve(msg("Checked linked issues"))
          : resolve(msg("Tried to check linked issues"));
      } else {
        label = done
          ? resolve(
              msg(
                "{count, plural, one {Checked linked issues {count} time} other {Checked linked issues {count} times}}",
                { count },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Tried to check linked issues {count} time} other {Tried to check linked issues {count} times}}",
                { count },
              ),
            );
      }
      break;
    }
    case "html-preview": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Previewed {count} HTML page} other {Previewed {count} HTML pages}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to preview {count} HTML page} other {Tried to preview {count} HTML pages}}",
              { count },
            ),
          );
      break;
    }
    case "html-render": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Rendered {count} HTML page} other {Rendered {count} HTML pages}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to render {count} HTML page} other {Tried to render {count} HTML pages}}",
              { count },
            ),
          );
      break;
    }
    case "send-to-user": {
      const count = selected.length;
      label = done
        ? resolve(
            msg("{count, plural, one {Sent {count} message} other {Sent {count} messages}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to send {count} message} other {Tried to send {count} messages}}",
              { count },
            ),
          );
      break;
    }
    case "thread-list": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Listed threads {count} time} other {Listed threads {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to list threads {count} time} other {Tried to list threads {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "task-status": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Checked task status {count} time} other {Checked task status {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to check task status {count} time} other {Tried to check task status {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "background-wait": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Updated background waits {count} time} other {Updated background waits {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to update background waits {count} time} other {Tried to update background waits {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "mcp-server": {
      const count = selected.length;
      label = resolve(
        msg(
          "{count, plural, one {Managed MCP server sign-in {count} time} other {Managed MCP server sign-in {count} times}}",
          { count },
        ),
      );
      break;
    }
    case "schedule-list": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Listed scheduled tasks {count} time} other {Listed scheduled tasks {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to list scheduled tasks {count} time} other {Tried to list scheduled tasks {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "thread-configuration": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Checked thread configuration {count} time} other {Checked thread configuration {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to check thread configuration {count} time} other {Tried to check thread configuration {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "thread-configure": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Set thread model {count} time} other {Set thread model {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to set thread model {count} time} other {Tried to set thread model {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "thread-search": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Searched threads {count} time} other {Searched threads {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to search threads {count} time} other {Tried to search threads {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "thread-transfers": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Checked thread transfers {count} time} other {Checked thread transfers {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to check thread transfers {count} time} other {Tried to check thread transfers {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "thread-organize": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Organized threads {count} time} other {Organized threads {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to organize threads {count} time} other {Tried to organize threads {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "queue-list": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Listed queued messages {count} time} other {Listed queued messages {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to list queued messages {count} time} other {Tried to list queued messages {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "question-list": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Listed pending questions {count} time} other {Listed pending questions {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to list pending questions {count} time} other {Tried to list pending questions {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "worktree-list": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Listed workspace branches {count} time} other {Listed workspace branches {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to list workspace branches {count} time} other {Tried to list workspace branches {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "worktree-status": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Checked worktree status {count} time} other {Checked worktree status {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to check worktree status {count} time} other {Tried to check worktree status {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "project-list": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Listed projects {count} time} other {Listed projects {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to list projects {count} time} other {Tried to list projects {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "environment-read": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Checked environment preferences {count} time} other {Checked environment preferences {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to check environment preferences {count} time} other {Tried to check environment preferences {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "environment-update": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Updated environment preferences {count} time} other {Updated environment preferences {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to update environment preferences {count} time} other {Tried to update environment preferences {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "theme-read": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Checked themes {count} time} other {Checked themes {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to check themes {count} time} other {Tried to check themes {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "theme-set": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Set the theme {count} time} other {Set the theme {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to set the theme {count} time} other {Tried to set the theme {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "environment-links": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Listed linked environments {count} time} other {Listed linked environments {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to list linked environments {count} time} other {Tried to list linked environments {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "browser": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Used browser {count} time} other {Used browser {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to use browser {count} time} other {Tried to use browser {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "device": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Used device controls {count} time} other {Used device controls {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to use device controls {count} time} other {Tried to use device controls {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "capabilities": {
      const count = selected.length;
      label = done
        ? resolve(
            msg(
              "{count, plural, one {Checked orchestration capabilities {count} time} other {Checked orchestration capabilities {count} times}}",
              { count },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Tried to check orchestration capabilities {count} time} other {Tried to check orchestration capabilities {count} times}}",
              { count },
            ),
          );
      break;
    }
    case "thread-read": {
      if (threadIds.every((value) => value !== undefined)) {
        const count = new Set(threadIds).size;
        label = done
          ? resolve(
              msg("{count, plural, one {Read {count} thread} other {Read {count} threads}}", {
                count,
              }),
            )
          : resolve(
              msg(
                "{count, plural, one {Tried to read {count} thread} other {Tried to read {count} threads}}",
                { count },
              ),
            );
      } else {
        const count = selected.length;
        label = done
          ? resolve(
              msg(
                "{count, plural, one {Read threads {count} time} other {Read threads {count} times}}",
                { count },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Tried to read threads {count} time} other {Tried to read threads {count} times}}",
                { count },
              ),
            );
      }
      break;
    }
    case "thread-wait": {
      if (threadIds.every((value) => value !== undefined)) {
        const count = new Set(threadIds).size;
        label = done
          ? resolve(
              msg(
                "{count, plural, one {Waited on {count} thread} other {Waited on {count} threads}}",
                { count },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Tried to wait on {count} thread} other {Tried to wait on {count} threads}}",
                { count },
              ),
            );
      } else {
        const count = selected.length;
        label = done
          ? resolve(
              msg(
                "{count, plural, one {Waited on threads {count} time} other {Waited on threads {count} times}}",
                { count },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Tried to wait on threads {count} time} other {Tried to wait on threads {count} times}}",
                { count },
              ),
            );
      }
      break;
    }
    case "thread-send": {
      const messages = countEntities(selected.map((call) => id(call.output?.messageId)));
      const threads = new Set(threadIds).size;
      if (!threadIds.every((value) => value !== undefined)) {
        const count = messages;
        label = done
          ? resolve(
              msg("{count, plural, one {Sent {count} message} other {Sent {count} messages}}", {
                count,
              }),
            )
          : resolve(
              msg(
                "{count, plural, one {Tried to send {count} message} other {Tried to send {count} messages}}",
                { count },
              ),
            );
      } else if (messages === threads && messages > 1) {
        label = done
          ? resolve(
              msg(
                "{threads, plural, one {Sent messages to {threads} thread} other {Sent messages to {threads} threads}}",
                { threads },
              ),
            )
          : resolve(
              msg(
                "{threads, plural, one {Tried to send messages to {threads} thread} other {Tried to send messages to {threads} threads}}",
                { threads },
              ),
            );
      } else {
        label = done
          ? resolve(
              msg(
                "{messages, plural, one {Sent {messages} message to {threads, plural, one {{threads} thread} other {{threads} threads}}} other {Sent {messages} messages to {threads, plural, one {{threads} thread} other {{threads} threads}}}}",
                { messages, threads },
              ),
            )
          : resolve(
              msg(
                "{messages, plural, one {Tried to send {messages} message to {threads, plural, one {{threads} thread} other {{threads} threads}}} other {Tried to send {messages} messages to {threads, plural, one {{threads} thread} other {{threads} threads}}}}",
                { messages, threads },
              ),
            );
      }
      break;
    }
    case "thread-create": {
      const createdIds: string[] = [];
      const resultsKnown =
        completed.length > 0 &&
        completed.every((call) => {
          const threads = Array.isArray(call.output?.threads) ? call.output.threads : [call.output];
          return threads.every((thread) => {
            const record = asRecord(thread);
            if (record?.status === "rolled_back") return true;
            const threadId = id(record?.threadId);
            if (!threadId) return false;
            createdIds.push(threadId);
            return true;
          });
        });
      if (resultsKnown) {
        const count = new Set(createdIds).size;
        label = resolve(
          msg("{count, plural, one {Created {count} thread} other {Created {count} threads}}", {
            count,
          }),
        );
      } else {
        const count = selected.length;
        label = resolve(
          msg(
            "{count, plural, one {Requested thread creation {count} time} other {Requested thread creation {count} times}}",
            { count },
          ),
        );
      }
      break;
    }
    case "attachment-send": {
      const messages = new Map<string, (typeof selected)[number]>();
      selected.forEach((call, index) =>
        messages.set(id(call.output?.messageId) ?? `call-${index}`, call),
      );
      const attachments = [...messages.values()].reduce(
        (count, call) =>
          count + (Array.isArray(call.input?.attachments) ? call.input.attachments.length : 0),
        0,
      );
      const countsKnown = [...messages.values()].every(
        (call) => Array.isArray(call.input?.attachments) && call.input.attachments.length > 0,
      );
      const threads = new Set(threadIds).size;
      const count = selected.length;
      if (threadIds.every((value) => value !== undefined)) {
        label = countsKnown
          ? done
            ? resolve(
                msg(
                  "{attachments, plural, one {Sent {attachments} attachment to {threads, plural, one {{threads} thread} other {{threads} threads}}} other {Sent {attachments} attachments to {threads, plural, one {{threads} thread} other {{threads} threads}}}}",
                  { attachments, threads },
                ),
              )
            : resolve(
                msg(
                  "{attachments, plural, one {Tried to send {attachments} attachment to {threads, plural, one {{threads} thread} other {{threads} threads}}} other {Tried to send {attachments} attachments to {threads, plural, one {{threads} thread} other {{threads} threads}}}}",
                  { attachments, threads },
                ),
              )
          : done
            ? resolve(
                msg(
                  "{count, plural, one {Sent attachments to {threads, plural, one {{threads} thread} other {{threads} threads}} {count} time} other {Sent attachments to {threads, plural, one {{threads} thread} other {{threads} threads}} {count} times}}",
                  { threads, count },
                ),
              )
            : resolve(
                msg(
                  "{count, plural, one {Tried to send attachments to {threads, plural, one {{threads} thread} other {{threads} threads}} {count} time} other {Tried to send attachments to {threads, plural, one {{threads} thread} other {{threads} threads}} {count} times}}",
                  { threads, count },
                ),
              );
      } else {
        label = countsKnown
          ? done
            ? resolve(
                msg(
                  "{attachments, plural, one {Sent {attachments} attachment} other {Sent {attachments} attachments}}",
                  { attachments },
                ),
              )
            : resolve(
                msg(
                  "{attachments, plural, one {Tried to send {attachments} attachment} other {Tried to send {attachments} attachments}}",
                  { attachments },
                ),
              )
          : done
            ? resolve(
                msg(
                  "{count, plural, one {Sent attachments {count} time} other {Sent attachments {count} times}}",
                  { count },
                ),
              )
            : resolve(
                msg(
                  "{count, plural, one {Tried to send attachments {count} time} other {Tried to send attachments {count} times}}",
                  { count },
                ),
              );
      }
      break;
    }
    case "link-pr": {
      const count = pullRequestCount(selected, "linkedCount");
      if (count === null) {
        label = done
          ? resolve(msg("Linked pull requests"))
          : resolve(msg("Tried to link pull requests"));
      } else {
        label = done
          ? resolve(
              msg(
                "{count, plural, one {Linked {count} pull request} other {Linked {count} pull requests}}",
                { count },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Tried to link {count} pull request} other {Tried to link {count} pull requests}}",
                { count },
              ),
            );
      }
      break;
    }
    case "unlink-pr": {
      const count = pullRequestCount(selected, "unlinkedCount");
      if (count === null) {
        label = done
          ? resolve(msg("Unlinked pull requests"))
          : resolve(msg("Tried to unlink pull requests"));
      } else {
        label = done
          ? resolve(
              msg(
                "{count, plural, one {Unlinked {count} pull request} other {Unlinked {count} pull requests}}",
                { count },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Tried to unlink {count} pull request} other {Tried to unlink {count} pull requests}}",
                { count },
              ),
            );
      }
      break;
    }
    case "list-prs": {
      const count = selected.length;
      if (count === 1) {
        label = done
          ? resolve(msg("Checked linked pull requests"))
          : resolve(msg("Tried to check linked pull requests"));
      } else {
        label = done
          ? resolve(
              msg(
                "{count, plural, one {Checked linked pull requests {count} time} other {Checked linked pull requests {count} times}}",
                { count },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Tried to check linked pull requests {count} time} other {Tried to check linked pull requests {count} times}}",
                { count },
              ),
            );
      }
      break;
    }
    case "write-pr-guides": {
      // One call writes many guides, and reports a refusal per guide rather than failing.
      const outcomes = selected.flatMap((call) =>
        Array.isArray(call.output?.guides)
          ? call.output.guides.map((guide) => asRecord(guide)?.outcome)
          : [],
      );
      const started = outcomes.filter((outcome) => outcome !== "failed").length;
      const failed = outcomes.length - started;
      failedCount += failed;
      if (outcomes.length === 0) {
        const count = selected.length;
        label =
          count === 1
            ? done
              ? resolve(msg("Started writing review guides"))
              : resolve(msg("Tried to start writing review guides"))
            : done
              ? resolve(
                  msg(
                    "{count, plural, one {Started writing review guides {count} time} other {Started writing review guides {count} times}}",
                    { count },
                  ),
                )
              : resolve(
                  msg(
                    "{count, plural, one {Tried to start writing review guides {count} time} other {Tried to start writing review guides {count} times}}",
                    { count },
                  ),
                );
      } else if (started === 0) {
        label = resolve(
          msg(
            "{failed, plural, one {Could not start {failed} review guide} other {Could not start {failed} review guides}}",
            { failed },
          ),
        );
      } else if (failed > 0) {
        label = done
          ? resolve(
              msg(
                "{started, plural, one {Started {started} review guide, {failed} failed} other {Started {started} review guides, {failed} failed}}",
                { started, failed },
              ),
            )
          : resolve(
              msg(
                "{started, plural, one {Tried to start {started} review guide, {failed} failed} other {Tried to start {started} review guides, {failed} failed}}",
                { started, failed },
              ),
            );
      } else {
        label = done
          ? resolve(
              msg(
                "{started, plural, one {Started {started} review guide} other {Started {started} review guides}}",
                { started },
              ),
            )
          : resolve(
              msg(
                "{started, plural, one {Tried to start {started} review guide} other {Tried to start {started} review guides}}",
                { started },
              ),
            );
      }
      break;
    }
  }
  return { label, failedCount };
}
