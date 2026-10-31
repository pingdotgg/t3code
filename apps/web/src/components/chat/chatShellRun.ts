import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";

export interface ChatShellRun {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
}

export type ChatShellCommandRunner = (
  command: string,
  onStarted: (run: ChatShellRun) => void,
  terminalId?: string,
) => void;

export interface ChatShellRunOutput {
  readonly text: string;
  readonly exitCode: number | null;
}

export function createChatShellRunId(): string {
  return randomUUID().replaceAll("-", "");
}

const RUN_MARKER_OSC = 7717;

/**
 * Runs the command as one line in a subshell, so it starts in `cwd`, leaves the shell's own state
 * alone, and survives an `exit`. The line clears its own echo and shows the command instead, and
 * the run's bounds are OSC sequences, which terminals do not draw. The leading space keeps the
 * line out of shell history where that is configured.
 */
export function chatShellRunInput(command: string, id: string, cwd: string): string {
  const shown = shellQuote(command.replace(/^/gm, "$ "));
  const run = `(cd ${shellQuote(cwd)} && eval ${shellQuote(command)})`;
  const start = `printf '\\033[3J\\033[2J\\033[H%s\\n\\033]${RUN_MARKER_OSC};T3S;${id}\\007' ${shown}`;
  const end = `printf '\\033]${RUN_MARKER_OSC};T3E;${id};%s\\007' "$?"`;
  return ` ${start}; ${run}; ${end}\r`;
}

function shellQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t");
  return `$'${escaped}'`;
}

const TERMINAL_CONTROL_SEQUENCES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()*+][0-9A-Za-z]|\u001b[@-Z\\-_]/g;

function plainTerminalText(raw: string): string {
  return raw
    .replace(TERMINAL_CONTROL_SEQUENCES, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

export function parseChatShellRunOutput(raw: string, id: string): ChatShellRunOutput {
  const marker = (body: string) => `\\u001b\\]${RUN_MARKER_OSC};${body}\\u0007`;
  const start = new RegExp(marker(`T3S;${id}`)).exec(raw);
  const end = new RegExp(marker(`T3E;${id};(\\d+)`)).exec(raw);
  // Long output can push the start marker out of the retained buffer.
  if (start === null && end === null) return { text: "", exitCode: null };
  const output = plainTerminalText(
    raw.slice(start === null ? 0 : start.index + start[0].length, end?.index),
  );
  return end === null
    ? { text: output, exitCode: null }
    : { text: output.replace(/\n+$/, ""), exitCode: Number(end[1]) };
}

const RESULT_MESSAGE_TAG = "t3_code_block_run";
const MAX_RESULT_OUTPUT_CHARS = 20_000;

export function chatShellRunResultMessage(command: string, output: ChatShellRunOutput): string {
  const text = output.text.slice(-MAX_RESULT_OUTPUT_CHARS);
  return [
    `<${RESULT_MESSAGE_TAG}>`,
    "I ran this code block from the chat. React to the result.",
    "",
    "Command:",
    command,
    "",
    `Exit code: ${output.exitCode}`,
    text.length < output.text.length ? `Output (last ${text.length} characters):` : "Output:",
    text,
    `</${RESULT_MESSAGE_TAG}>`,
  ].join("\n");
}

/** A run's result reaches the agent as a user message that clients do not display. */
export function isChatShellRunResultMessage(text: string): boolean {
  return text.startsWith(`<${RESULT_MESSAGE_TAG}>`);
}
