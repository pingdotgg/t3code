// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { AgentHistoryEntry, OrchestrationGetAgentHistoryResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  agentHistoryEntry,
  boundedHistoryJson,
  boundedHistoryText,
  collectAgentHistory,
  type BoundedHistoryText,
} from "./agentHistory.ts";

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_RECORDS = 50_000;
const MAX_TRANSCRIPT_LINE_BYTES = 1024 * 1024;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

const isAgentId = Schema.is(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)));
const isSessionId = Schema.is(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]+$/)));

const decodeTranscriptEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
  { onExcessProperty: "preserve" },
);
const decodeHistoryMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literals(["user", "assistant"]),
    uuid: Schema.String,
    message: Schema.Unknown,
  }),
);
const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  content: Schema.optionalKey(Schema.Unknown),
  is_error: Schema.optionalKey(Schema.Boolean),
});
const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    content: Schema.Union([Schema.String, Schema.Array(ContentBlock)]),
  }),
);
const decodeTextContent = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** Return an empty history response with a recoverable explanation for the client. */
const unavailable = (message: string): OrchestrationGetAgentHistoryResult => ({
  status: "unavailable",
  entries: [],
  nextOffset: null,
  message,
});

/** Missing transcript directories mean no saved history; other filesystem errors remain visible. */
async function directoryEntries(path: string) {
  try {
    return await NodeFSP.readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** Use lstat so a symlink cannot redirect traversal outside the configured transcript store. */
async function isDirectory(path: string) {
  try {
    return (await NodeFSP.lstat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Stream only complete bounded JSONL records and never read bytes appended after the initial stat. */
async function* transcriptLines(
  handle: NodeFSP.FileHandle,
  size: number,
): AsyncGenerator<{ readonly text: string; readonly complete: boolean }> {
  const buffer = Buffer.allocUnsafe(TRANSCRIPT_READ_CHUNK_BYTES);
  let pending = Buffer.alloc(0);
  let droppingOversizedLine = false;
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    let start = 0;
    for (let index = 0; index < bytesRead; index++) {
      if (buffer[index] !== 10) continue;
      const fragment = buffer.subarray(start, index);
      if (!droppingOversizedLine && pending.length + fragment.length <= MAX_TRANSCRIPT_LINE_BYTES) {
        const line =
          pending.length === 0
            ? fragment.toString("utf8")
            : Buffer.concat([pending, fragment]).toString("utf8");
        if (line.trim()) yield { text: line, complete: true };
      }
      pending = Buffer.alloc(0);
      droppingOversizedLine = false;
      start = index + 1;
    }
    const tail = buffer.subarray(start, bytesRead);
    if (droppingOversizedLine) continue;
    if (pending.length + tail.length > MAX_TRANSCRIPT_LINE_BYTES) {
      pending = Buffer.alloc(0);
      droppingOversizedLine = true;
    } else if (tail.length > 0) {
      pending = pending.length === 0 ? Buffer.from(tail) : Buffer.concat([pending, tail]);
    }
  }
  if (!droppingOversizedLine && pending.length > 0)
    yield { text: pending.toString("utf8"), complete: false };
}

/** Find only regular child transcripts inside the persisted parent's directory. */
async function findTranscript(
  directory: string,
  filename: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 16) return null;
  const entries = await directoryEntries(directory);
  if (entries.some((entry) => entry.name === filename && entry.isFile()))
    return NodePath.join(directory, filename);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findTranscript(NodePath.join(directory, entry.name), filename, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Extract only textual tool results; image and other binary blocks are not activity text. */
function resultText(content: unknown): BoundedHistoryText {
  if (typeof content === "string") return boundedHistoryText([content]);
  const blocks = decodeTextContent(content);
  return blocks._tag === "Some"
    ? boundedHistoryText(blocks.value.flatMap((block) => (block.text ? [block.text] : [])))
    : { text: "", truncated: false };
}

/** Skip unsupported transcript records while retaining the rest of the saved conversation. */
export function claudeHistoryEntries(message: {
  readonly type: "user" | "assistant";
  readonly uuid: string;
  readonly message: unknown;
}): AgentHistoryEntry[] {
  const decoded = decodeMessage(message.message);
  if (decoded._tag === "None") return [];
  const { content } = decoded.value;
  if (typeof content === "string")
    return content
      ? [
          agentHistoryEntry(
            message.uuid,
            message.type === "user" ? "user" : "assistant",
            message.type === "user" ? "Prompt" : "Agent",
            content,
          ),
        ]
      : [];
  return content.flatMap((block, index): AgentHistoryEntry[] => {
    const id = `${message.uuid}:${index}`;
    switch (block.type) {
      case "text":
        return block.text
          ? [
              agentHistoryEntry(
                id,
                message.type === "user" ? "user" : "assistant",
                message.type === "user" ? "Prompt" : "Agent",
                block.text,
              ),
            ]
          : [];
      case "thinking":
        return block.thinking
          ? [agentHistoryEntry(id, "reasoning", "Reasoning", block.thinking)]
          : [];
      case "tool_use": {
        const fileEdit =
          block.name === "Edit" || block.name === "Write" || block.name === "MultiEdit";
        const path =
          block.input &&
          typeof block.input === "object" &&
          "file_path" in block.input &&
          typeof block.input.file_path === "string"
            ? block.input.file_path
            : null;
        const detail = boundedHistoryJson(block.input ?? {});
        return [
          agentHistoryEntry(
            id,
            fileEdit ? "file-edit" : "tool",
            fileEdit && path ? `Edit ${path}` : (block.name ?? "Tool"),
            detail.text,
            detail.truncated,
          ),
        ];
      }
      case "tool_result": {
        const detail = resultText(block.content);
        return [
          agentHistoryEntry(
            id,
            "tool",
            block.is_error ? "Tool error" : "Tool result",
            detail.text,
            detail.truncated,
          ),
        ];
      }
      default:
        return [];
    }
  });
}

/** Stream a bounded child transcript and stop as soon as the requested page is complete. */
export async function readClaudeAgentHistory(input: {
  configDir: string;
  sessionId: string;
  agentId: string;
  offset: number;
  view?: "recent-tools" | "latest" | undefined;
}): Promise<OrchestrationGetAgentHistoryResult> {
  if (!isAgentId(input.agentId) || !isSessionId(input.sessionId)) {
    return unavailable("No saved transcript is available for this agent.");
  }
  const projectsDir = NodePath.join(input.configDir, "projects");
  let transcript: string | null = null;
  for (const project of await directoryEntries(projectsDir)) {
    if (!project.isDirectory()) continue;
    const projectDir = NodePath.join(projectsDir, project.name);
    const sessionDir = NodePath.join(projectDir, input.sessionId);
    if (
      !(await isDirectory(sessionDir)) ||
      !(await isDirectory(NodePath.join(sessionDir, "subagents")))
    )
      continue;
    transcript = await findTranscript(
      NodePath.join(sessionDir, "subagents"),
      `agent-${input.agentId}.jsonl`,
    );
    if (transcript) break;
  }
  if (!transcript)
    return unavailable("Claude has no saved transcript for this agent in this session.");
  const handle = await NodeFSP.open(
    transcript,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return unavailable("The agent transcript is not a regular file.");
    if (stat.size > MAX_TRANSCRIPT_BYTES)
      return unavailable("This agent transcript is too large to load.");
    const page = collectAgentHistory(input);
    let decodedRecords = 0;
    for await (const line of transcriptLines(handle, stat.size)) {
      let entry: ReturnType<typeof decodeTranscriptEntry>;
      try {
        entry = decodeTranscriptEntry(line.text);
      } catch (error) {
        // A running Claude process may still be writing the final JSONL record.
        if (!line.complete) break;
        throw error;
      }
      if (++decodedRecords > MAX_TRANSCRIPT_RECORDS)
        return unavailable("This agent transcript has too many records to load.");
      const message = decodeHistoryMessage(entry);
      if (message._tag === "None") continue;
      for (const historyEntry of claudeHistoryEntries(message.value)) {
        if (page.add(historyEntry)) return page.result();
      }
    }
    return page.result();
  } finally {
    await handle.close();
  }
}
