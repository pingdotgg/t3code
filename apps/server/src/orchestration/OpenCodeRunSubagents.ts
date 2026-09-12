import {
  EventId,
  RuntimeTaskId,
  type ProviderRuntimeEvent,
  type RuntimeTaskUsage,
} from "@t3tools/contracts";

/**
 * Bridges `opencode run` invocations made through a provider's shell tool
 * (Claude's Bash, Codex's exec, ACP execute) into task.* runtime events, so a
 * thread that delegates to OpenCode from another provider shows the delegated
 * run and its native subagents in the Agents panel and sidebar liveness.
 *
 * The shell tool is the only signal: the run itself starts when the command
 * item starts and settles when the item completes. When the command asked
 * for `--format json`, the captured output also yields the run's token usage,
 * its final text, and one settled child per OpenCode `task` tool call.
 */

export interface OpenCodeRunInvocation {
  readonly prompt: string | undefined;
  readonly model: string | undefined;
  readonly agent: string | undefined;
  readonly jsonOutput: boolean;
}

interface ShellToken {
  readonly text: string;
  readonly quoted: boolean;
  readonly assignment?: boolean;
}

const MAX_PROMPT_LENGTH = 200;
const MAX_NESTED_COMMAND_DEPTH = 2;
const COMMAND_SEPARATOR = /^(\|[|&]?|&&|;|&)$/;
const REDIRECT_PREFIX = /^(?:\d*[<>]|&>)/;
const REDIRECT_WITH_OPERAND = /^(?:\d*(>>?|<|<<-?|<<<|[<>]&)|&>>?)$/;
const VALUE_OPTIONS = new Set([
  "-m",
  "--model",
  "--agent",
  "--variant",
  "-s",
  "--session",
  "--format",
  "--command",
  "--dir",
  "--attach",
  "-p",
  "--password",
  "-u",
  "--username",
  "--log-level",
  "-f",
  "--file",
]);
// yargs treats these as optional-value options: the next token is only the
// value when it does not look like another option.
const OPTIONAL_VALUE_OPTIONS = new Set(["--title", "--port"]);

/** Splits a command line into words, honoring quotes, escapes, and separators. */
function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let text = "";
  let quoted = false;
  let inToken = false;
  let assignment = false;
  let quote: '"' | "'" | null = null;
  const hereDocuments: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let awaitingHereDocument: { stripTabs: boolean } | undefined;
  const flush = () => {
    if (inToken) {
      tokens.push({ text, quoted, assignment });
      if (awaitingHereDocument) {
        hereDocuments.push({ delimiter: text, ...awaitingHereDocument });
        awaitingHereDocument = undefined;
      }
    }
    text = "";
    quoted = false;
    inToken = false;
    assignment = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        text += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && index + 1 < command.length) {
        index += 1;
        const next = command[index]!;
        if (next !== "\n") {
          text += next;
        }
      } else {
        text += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      inToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 1;
      const next = command[index]!;
      if (next !== "\n") {
        text += next;
        quoted = true;
        inToken = true;
      }
      continue;
    }
    // A hash begins a comment only outside quotes and at a word boundary.
    // Leave the newline for normal command/heredoc processing.
    if (char === "#" && !inToken) {
      const newline = command.indexOf("\n", index);
      index = newline === -1 ? command.length : newline - 1;
      continue;
    }
    if (char === "\n") {
      flush();
      tokens.push({ text: ";", quoted: false });
      // Bodies begin after the command line, in redirect order. Their contents
      // are input data, not shell commands; quote removal already decoded each
      // delimiter in flush(). An unfinished body consumes the remaining input.
      for (const { delimiter, stripTabs } of hereDocuments) {
        let start = index + 1;
        while (start < command.length) {
          const newline = command.indexOf("\n", start);
          const end = newline === -1 ? command.length : newline;
          const line = command.slice(start, end);
          index = end;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
            break;
          }
          start = end + 1;
        }
      }
      hereDocuments.length = 0;
      continue;
    }
    if (char === "<" || char === ">") {
      // Only an unquoted all-digit word immediately before the operator is
      // a file descriptor; quoted digits remain ordinary command arguments.
      const descriptor = inToken && !quoted && /^\d+$/.test(text) ? text : "";
      if (descriptor) {
        inToken = false;
      }
      flush();
      const next = command[index + 1];
      const suffix = command[index + 2];
      const operator =
        char === "<" && next === "<"
          ? suffix === "<"
            ? "<<<"
            : suffix === "-"
              ? "<<-"
              : "<<"
          : next === char || next === "&"
            ? char + next
            : char;
      tokens.push({ text: descriptor + operator, quoted: false });
      if (operator === "<<" || operator === "<<-") {
        awaitingHereDocument = { stripTabs: operator === "<<-" };
      }
      index += operator.length - 1;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (char === "&" && command[index + 1] === ">") {
      flush();
      const append = command[index + 2] === ">";
      tokens.push({ text: append ? "&>>" : "&>", quoted: false });
      index += append ? 2 : 1;
      continue;
    }
    // Separators need no surrounding whitespace (`ls;opencode run`, `… |head`);
    // `&` stays attached inside redirects such as `2>&1`.
    if (char === ";" || char === "|" || (char === "&" && !text.endsWith(">"))) {
      flush();
      const next = command[index + 1];
      const paired = char !== ";" && (next === char || (char === "|" && next === "&"));
      tokens.push({ text: paired ? char + next : char, quoted: false });
      if (paired) {
        index += 1;
      }
      continue;
    }
    if (char === "=" && !quoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
      assignment = true;
    }
    text += char;
    inToken = true;
  }
  flush();
  return tokens;
}

/** Redirections belong to the shell, not the executable's option arguments. */
function withoutShellRedirects(tokens: ReadonlyArray<ShellToken>): ShellToken[] {
  const words: ShellToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.quoted && REDIRECT_PREFIX.test(token.text)) {
      const next = tokens[index + 1];
      if (
        REDIRECT_WITH_OPERAND.test(token.text) &&
        next &&
        (next.quoted || !COMMAND_SEPARATOR.test(next.text))
      ) {
        index += 1;
      }
    } else {
      words.push(token);
    }
  }
  return words;
}

/** Executable basename after shell quote removal. */
function executableName(token: ShellToken): string | undefined {
  const slash = token.text.lastIndexOf("/");
  return slash === -1 ? token.text : token.text.slice(slash + 1);
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const DURATION_OR_NUMBER = /^\d+(\.\d+)?[smhd]?$/;
// Wrappers that run their trailing argv as the real command.
const TRANSPARENT_WRAPPERS = new Set(["env", "exec", "nohup", "time", "timeout", "command"]);

/**
 * Whether the token at `index` begins a simple command: it is first on the
 * line, follows a separator, or is only preceded by env assignments and
 * transparent wrappers such as `timeout 60`. Keeps `echo opencode run …` and
 * `grep opencode run .` from reading as invocations.
 */
function startsSimpleCommand(tokens: ReadonlyArray<ShellToken>, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor]!;
    if (!token.quoted && COMMAND_SEPARATOR.test(token.text)) {
      return true;
    }
    if (
      token.assignment ||
      token.text.startsWith("-") ||
      DURATION_OR_NUMBER.test(token.text) ||
      TRANSPARENT_WRAPPERS.has(executableName(token) ?? "")
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/** `zsh -lc "<script>"` style wrappers, as Codex and some hooks spawn them. */
function isShellWrapperScript(tokens: ReadonlyArray<ShellToken>, index: number): boolean {
  const flag = tokens[index - 1];
  const shell = tokens[index - 2];
  return (
    tokens[index]!.quoted &&
    flag !== undefined &&
    SHELL_COMMAND_FLAG.test(flag.text) &&
    shell !== undefined &&
    SHELL_EXECUTABLES.has(executableName(shell) ?? "") &&
    startsSimpleCommand(tokens, index - 2)
  );
}

/** An asynchronous shell list cannot mirror the delegated run's lifetime. */
function isBackgroundShellList(tokens: ReadonlyArray<ShellToken>, start = 0): boolean {
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]!;
    if (!token.quoted && token.text === "&") {
      return true;
    }
    if (!token.quoted && token.text === ";") {
      return false;
    }
  }
  return false;
}

/** Joins positional words into a compact prompt, or nothing when it is not readable. */
function normalizePrompt(parts: ReadonlyArray<string>): string | undefined {
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  // Command substitutions and heredocs carry no readable prompt.
  if (joined.length === 0 || joined.includes("$(") || joined.includes("`")) {
    return undefined;
  }
  return joined.length > MAX_PROMPT_LENGTH
    ? `${joined.slice(0, MAX_PROMPT_LENGTH - 3)}...`
    : joined;
}

/**
 * Parses the argv after `opencode run`. Returns undefined when the shell
 * backgrounds the run with a trailing `&`: the shell item then returns while
 * OpenCode is still working, so there is no lifecycle to mirror.
 */
function parseInvocationTokens(
  tokens: ReadonlyArray<ShellToken>,
): OpenCodeRunInvocation | undefined {
  if (isBackgroundShellList(tokens)) {
    return undefined;
  }
  const positionals: string[] = [];
  const options = new Map<string, string>();
  let optionsEnded = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.quoted) {
      if (token.text === "&") {
        return undefined;
      }
      if (COMMAND_SEPARATOR.test(token.text)) {
        break;
      }
    }
    if (optionsEnded || !token.text.startsWith("-")) {
      positionals.push(token.text);
      continue;
    }
    if (token.text === "--") {
      optionsEnded = true;
      continue;
    }
    const equals = token.text.indexOf("=");
    const name = equals === -1 ? token.text : token.text.slice(0, equals);
    if (equals !== -1) {
      options.set(name, token.text.slice(equals + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (next && !next.quoted && COMMAND_SEPARATOR.test(next.text)) {
      break;
    }
    if (VALUE_OPTIONS.has(name)) {
      if (next !== undefined) {
        options.set(name, next.text);
        index += 1;
      }
      continue;
    }
    if (OPTIONAL_VALUE_OPTIONS.has(name) && next !== undefined && !next.text.startsWith("-")) {
      index += 1;
    }
  }
  const model = options.get("-m") ?? options.get("--model");
  const agent = options.get("--agent");
  return {
    prompt: normalizePrompt(positionals),
    model: model && model.length > 0 ? model : undefined,
    agent: agent && agent.length > 0 ? agent : undefined,
    jsonOutput: options.get("--format") === "json",
  };
}

// Options the CLI accepts before the subcommand, e.g. `opencode --log-level
// DEBUG run …`. Only `--log-level` takes a separate value.
const GLOBAL_VALUE_OPTIONS = new Set(["--log-level"]);

/** Index of the first non-option token after the binary, i.e. the subcommand. */
function subcommandIndex(tokens: ReadonlyArray<ShellToken>, start: number): number | undefined {
  let cursor = start;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (!token.quoted && COMMAND_SEPARATOR.test(token.text)) {
      return undefined;
    }
    if (!token.text.startsWith("-")) {
      return cursor;
    }
    if (GLOBAL_VALUE_OPTIONS.has(token.text)) {
      const value = tokens[cursor + 1];
      if (!value || (!value.quoted && COMMAND_SEPARATOR.test(value.text))) {
        return undefined;
      }
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  return undefined;
}

/**
 * Recognizes an `opencode run …` invocation anywhere in a shell command line,
 * including behind `cd … &&`, env assignments, or a wrapper such as
 * `zsh -lc "opencode run …"`.
 */
export function parseOpenCodeRunCommand(
  command: string,
  depth = 0,
): OpenCodeRunInvocation | undefined {
  if (!command.includes("opencode")) {
    return undefined;
  }
  const tokens = withoutShellRedirects(tokenizeShell(command));
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (executableName(tokens[index]!) !== "opencode" || !startsSimpleCommand(tokens, index)) {
      continue;
    }
    const subcommand = subcommandIndex(tokens, index + 1);
    const next = subcommand === undefined ? undefined : tokens[subcommand];
    if (next !== undefined && next.text === "run") {
      const invocation = parseInvocationTokens(tokens.slice(subcommand! + 1));
      if (invocation) {
        return invocation;
      }
    }
  }
  if (depth >= MAX_NESTED_COMMAND_DEPTH) {
    return undefined;
  }
  for (let index = 2; index < tokens.length; index += 1) {
    if (isShellWrapperScript(tokens, index) && !isBackgroundShellList(tokens, index + 1)) {
      const nested = parseOpenCodeRunCommand(tokens[index]!.text, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

/** Narrows an unknown value to a plain object record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrows an unknown value to a string. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Rounds a finite non-negative number, rejecting anything else. */
function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * Each provider shapes `payload.data` differently: Claude stores the tool
 * input, Codex the native item, and the ACP adapters a flat record.
 */
function commandFromItemData(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  return (
    asString(data.command) ??
    asString(asRecord(data.input)?.command) ??
    asString(asRecord(data.item)?.command)
  );
}

/** Claude's Bash tool returns at once for `run_in_background`, so its output is elsewhere. */
function isBackgroundShellItem(data: Record<string, unknown> | undefined): boolean {
  return asRecord(data?.input)?.run_in_background === true;
}

/** Text of a tool result `content`, which is a string or an array of text blocks. */
function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        const record = asRecord(block);
        const nested = record?.type === "content" ? asRecord(record.content) : undefined;
        return (
          asString(record?.text) ?? (nested?.type === "text" ? asString(nested.text) : undefined)
        );
      })
      .filter((value): value is string => value !== undefined)
      .join("\n");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** Captured command output from each provider's `data` shape, if the item carries any. */
function outputFromItemData(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  const result = data.result;
  if (typeof result === "string") {
    return result;
  }
  const resultRecord = asRecord(result);
  if (resultRecord) {
    return textFromContent(resultRecord.content);
  }
  const item = asRecord(data.item);
  const aggregatedOutput = asString(item?.aggregatedOutput);
  if (aggregatedOutput !== undefined) {
    return aggregatedOutput;
  }
  const rawOutput = data.rawOutput;
  if (typeof rawOutput === "string") {
    return rawOutput;
  }
  const rawOutputRecord = asRecord(rawOutput);
  return (
    asString(rawOutputRecord?.stdout) ??
    asString(rawOutputRecord?.output) ??
    textFromContent(data.content)
  );
}

interface OpenCodeRunChild {
  readonly id: string;
  readonly title: string | undefined;
  readonly role: string | undefined;
  readonly model: string | undefined;
  readonly failed: boolean;
  readonly summary: string | undefined;
}

interface OpenCodeRunOutput {
  readonly children: ReadonlyArray<OpenCodeRunChild>;
  readonly summary: string | undefined;
  readonly usage: RuntimeTaskUsage | undefined;
  readonly failed: boolean;
}

const TASK_OUTPUT_WRAPPER =
  /^<task[^>]*>\s*(?:<summary>[\s\S]*?<\/summary>\s*)?<task_(?:result|error)>\s*([\s\S]*?)\s*<\/task_(?:result|error)>\s*<\/task>\s*$/;
const NATIVE_TASK_OUTPUT_WRAPPER =
  /^task_id:[^\r\n]*\r?\n\s*<task_result>\s*([\s\S]*?)\s*<\/task_result>\s*$/;

/** Result text of a child task, unwrapped from OpenCode's task result envelopes. */
function childSummary(output: unknown, error: unknown): string | undefined {
  const text = asString(error) ?? asString(output);
  if (!text) {
    return undefined;
  }
  const unwrapped =
    TASK_OUTPUT_WRAPPER.exec(text)?.[1] ?? NATIVE_TASK_OUTPUT_WRAPPER.exec(text)?.[1] ?? text;
  const trimmed = unwrapped.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** One settled child agent from a completed OpenCode `task` tool part. */
function childFromTaskPart(part: Record<string, unknown>, fallbackId: string): OpenCodeRunChild {
  const state = asRecord(part.state) ?? {};
  const input = asRecord(state.input) ?? {};
  const metadata = asRecord(state.metadata) ?? {};
  const model = asRecord(metadata.model);
  const modelId = asString(model?.modelID);
  const providerId = asString(model?.providerID);
  const description = asString(input.description)?.trim();
  const title = asString(state.title)?.trim();
  return {
    id: asString(metadata.sessionId) ?? asString(part.callID) ?? fallbackId,
    title: description || title || undefined,
    role: asString(input.subagent_type)?.trim() || undefined,
    model: modelId ? (providerId ? `${providerId}/${modelId}` : modelId) : undefined,
    failed: state.status === "error",
    summary: childSummary(state.output, state.error),
  };
}

/** Folds the raw JSON event lines printed by `opencode run --format json`. */
export function parseOpenCodeRunOutput(output: string): OpenCodeRunOutput {
  const children: OpenCodeRunChild[] = [];
  let summary: string | undefined;
  let failed = false;
  let steps = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let toolUses = 0;
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      continue;
    }
    const type = asString(event?.type);
    if (!event || !type) {
      continue;
    }
    const timestamp = asNonNegativeInt(event.timestamp);
    if (timestamp !== undefined) {
      firstTimestamp ??= timestamp;
      lastTimestamp = timestamp;
    }
    const part = asRecord(event.part);
    switch (type) {
      case "step_finish": {
        const tokens = asRecord(part?.tokens);
        if (!tokens) {
          break;
        }
        steps += 1;
        const input = asNonNegativeInt(tokens.input) ?? 0;
        const cached = asNonNegativeInt(asRecord(tokens.cache)?.read) ?? 0;
        const outputCount = asNonNegativeInt(tokens.output) ?? 0;
        const reasoning = asNonNegativeInt(tokens.reasoning) ?? 0;
        inputTokens += input;
        cachedInputTokens += cached;
        outputTokens += outputCount;
        reasoningTokens += reasoning;
        totalTokens += asNonNegativeInt(tokens.total) ?? input + cached + outputCount + reasoning;
        break;
      }
      case "text": {
        const text = asString(part?.text)?.trim();
        if (text) {
          summary = text;
        }
        break;
      }
      case "tool_use": {
        toolUses += 1;
        if (part && part.tool === "task") {
          children.push(childFromTaskPart(part, `task-${children.length + 1}`));
        }
        break;
      }
      case "error": {
        failed = true;
        break;
      }
      default:
        break;
    }
  }
  const usage: RuntimeTaskUsage | undefined =
    steps > 0
      ? {
          totalTokens,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens: reasoningTokens,
          toolUses,
          ...(firstTimestamp !== undefined && lastTimestamp !== undefined
            ? { durationMs: lastTimestamp - firstTimestamp }
            : {}),
        }
      : undefined;
  return { children, summary, usage, failed };
}

type TaskStartedEvent = Extract<ProviderRuntimeEvent, { type: "task.started" }>;
type TaskCompletedEvent = Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
type CommandItemEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

/** The event when it is a shell item lifecycle event with an item id. */
function asCommandItemEvent(event: ProviderRuntimeEvent): CommandItemEvent | undefined {
  if (
    (event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed") ||
    event.payload.itemType !== "command_execution" ||
    event.itemId === undefined
  ) {
    return undefined;
  }
  return event;
}

/** Ingestion state key for one shell item, so task.started goes out once. */
export function openCodeRunItemKey(event: ProviderRuntimeEvent): string | undefined {
  const item = asCommandItemEvent(event);
  return item ? `${item.threadId}:${item.itemId}` : undefined;
}

/** Identity fields shared by every task event of one delegated run. */
function taskLinkage(invocation: OpenCodeRunInvocation, toolUseId: string) {
  return {
    taskType: "subagent",
    title: invocation.prompt ?? "opencode run",
    role: invocation.agent ?? "opencode",
    ...(invocation.model ? { model: invocation.model } : {}),
    toolUseId,
  } as const;
}

/**
 * Derives the task.* events an `opencode run` shell item implies. `started`
 * tells whether this item's run already has a task.started; the caller owns
 * that memory because a Claude Bash item streams its input across several
 * item.updated events before the command is readable.
 */
export function deriveOpenCodeRunEvents(
  event: ProviderRuntimeEvent,
  options: { readonly started: boolean },
): ReadonlyArray<ProviderRuntimeEvent> {
  const item = asCommandItemEvent(event);
  if (!item) {
    return [];
  }
  const data = asRecord(item.payload.data);
  if (isBackgroundShellItem(data)) {
    return [];
  }
  const command = commandFromItemData(data);
  const invocation = command ? parseOpenCodeRunCommand(command) : undefined;
  if (!invocation) {
    return [];
  }
  const toolUseId = String(item.itemId);
  const taskId = RuntimeTaskId.make(`opencode-run:${toolUseId}`);
  const linkage = taskLinkage(invocation, toolUseId);
  const events: ProviderRuntimeEvent[] = [];
  const base = {
    provider: item.provider,
    ...(item.providerInstanceId !== undefined
      ? { providerInstanceId: item.providerInstanceId }
      : {}),
    threadId: item.threadId,
    createdAt: item.createdAt,
    ...(item.turnId !== undefined ? { turnId: item.turnId } : {}),
  };
  const push = (
    event:
      | { type: "task.started"; payload: TaskStartedEvent["payload"] }
      | { type: "task.completed"; payload: TaskCompletedEvent["payload"] },
  ) => {
    // Reserve ordinal 1 for the parent start even when it was already emitted.
    // Padding preserves lifecycle order when activities have equal timestamps.
    events.push({
      ...base,
      eventId: EventId.make(
        `opencode-run:${JSON.stringify([item.threadId, item.turnId ?? null, toolUseId])}:${String(events.length + 1 + (options.started ? 1 : 0)).padStart(8, "0")}`,
      ),
      ...event,
    });
  };
  if (!options.started) {
    push({
      type: "task.started",
      payload: {
        taskId,
        ...(invocation.prompt ? { description: invocation.prompt } : {}),
        ...linkage,
      },
    });
  }
  if (item.type !== "item.completed") {
    return events;
  }
  const output = outputFromItemData(data);
  const parsed =
    invocation.jsonOutput && output
      ? parseOpenCodeRunOutput(output)
      : { children: [], summary: output?.trim() || undefined, usage: undefined, failed: false };
  for (const child of parsed.children) {
    const childTaskId = RuntimeTaskId.make(`${taskId}:${child.id}`);
    const childLinkage = {
      taskType: "subagent",
      title: child.title ?? child.id,
      ...(child.role ? { role: child.role } : {}),
      ...(child.model ? { model: child.model } : {}),
      toolUseId,
    } as const;
    push({
      type: "task.started",
      payload: {
        taskId: childTaskId,
        ...(child.title ? { description: child.title } : {}),
        ...childLinkage,
      },
    });
    push({
      type: "task.completed",
      payload: {
        taskId: childTaskId,
        status: child.failed ? "failed" : "completed",
        ...(child.summary ? { summary: child.summary } : {}),
        ...childLinkage,
      },
    });
  }
  const itemFailed = item.payload.status === "failed" || item.payload.status === "declined";
  push({
    type: "task.completed",
    payload: {
      taskId,
      status: itemFailed || parsed.failed ? "failed" : "completed",
      ...(parsed.summary ? { summary: parsed.summary } : {}),
      ...(parsed.usage ? { typedUsage: parsed.usage } : {}),
      ...linkage,
    },
  });
  return events;
}
