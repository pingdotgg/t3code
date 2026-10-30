import { MAX_IMPORTED_MESSAGES } from "./AgentSessionScanner.ts";

export interface ClaudeExportMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ClaudeExportTranscript {
  readonly title: string;
  readonly messages: ReadonlyArray<ClaudeExportMessage>;
}

interface Block {
  readonly role: "user" | "assistant" | null;
  readonly lines: Array<string>;
  hasOutput: boolean;
}

// `/export` writes the rendered terminal transcript: `> ` opens a prompt, `⏺ ` (`● ` on
// Windows) opens assistant text or a tool call, `⎿` lines hold tool and command output,
// and continuation lines are indented two spaces.
const USER_PREFIX = /^> ?/;
const ASSISTANT_PREFIX = /^[⏺●] ?/;
const OUTPUT_LINE = /^\s*⎿/;
// Thinking, compaction separators, and the welcome banner carry no conversation text.
const IGNORED_LINE = /^[✻═╭│╰]/;
// Local commands (`/model`, `! ls`, `# memory`) echo output under the prompt instead of an answer.
const LOCAL_COMMAND = /^[/!#]/;

/** Parses a Claude Code `/export` text file into its visible user and assistant messages. */
export function parseClaudeExportTranscript(contents: string): ClaudeExportTranscript | null {
  const blocks: Array<Block> = [];
  let current: Block | undefined;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (USER_PREFIX.test(line) || ASSISTANT_PREFIX.test(line)) {
      const user = USER_PREFIX.test(line);
      current = {
        role: user ? "user" : "assistant",
        lines: [line.replace(user ? USER_PREFIX : ASSISTANT_PREFIX, "")],
        hasOutput: false,
      };
      blocks.push(current);
    } else if (OUTPUT_LINE.test(line)) {
      if (current) current.hasOutput = true;
      // Output runs until the next marker.
      current = undefined;
    } else if (IGNORED_LINE.test(line)) {
      current = { role: null, lines: [], hasOutput: false };
    } else if (current) {
      current.lines.push(line.startsWith("  ") ? line.slice(2) : line);
    }
  }

  const messages: Array<ClaudeExportMessage> = [];
  for (const block of blocks) {
    const text = block.lines.join("\n").trim();
    if (block.role === null || text === "") continue;
    if (block.role === "user") {
      if (!(block.hasOutput && LOCAL_COMMAND.test(text))) messages.push({ role: "user", text });
      continue;
    }
    // An assistant block with output is a tool call.
    if (block.hasOutput) continue;
    const previous = messages.at(-1);
    if (previous?.role === "assistant") {
      messages[messages.length - 1] = { role: "assistant", text: `${previous.text}\n\n${text}` };
    } else {
      messages.push({ role: "assistant", text });
    }
  }

  const firstUser = messages.find((message) => message.role === "user");
  if (firstUser === undefined) return null;
  const newest = messages.slice(-MAX_IMPORTED_MESSAGES);
  return {
    title: firstUser.text.split("\n")[0]!.slice(0, 100).trim() || "Imported thread",
    messages: newest.includes(firstUser)
      ? newest
      : [firstUser, ...messages.slice(-(MAX_IMPORTED_MESSAGES - 1))],
  };
}
