/**
 * Derive provider-neutral `ToolCallFacts` from a runtime item's native data.
 *
 * Each provider reports tool calls in its own vocabulary. Codex sends
 * `cwd`/`exitCode`/`durationMs`/`aggregatedOutput`/`changes[].diff` on the
 * item; Claude sends the tool input plus a `tool_result` block; the ACP
 * providers (Cursor, Grok) send `rawInput`/`rawOutput`/`content`; OpenCode
 * sends `state` with `input`/`output`/`time`. This module is the one place
 * that knows those shapes, so clients only ever read `payload.facts`.
 *
 * Output is bounded at derivation time (lines and bytes) because the facts
 * ride on every activity broadcast.
 *
 * @module orchestration/toolCallFacts
 */
import type {
  ProviderDriverKind,
  ToolCallFacts,
  ToolCallFactsFile,
  ToolCallFactsOutput,
} from "@t3tools/contracts";

export const TOOL_OUTPUT_MAX_LINES = 40;
export const TOOL_OUTPUT_MAX_CHARS = 4_000;
export const TOOL_DIFF_MAX_CHARS = 8_000;
const DIFF_STAT_MAX_LINES = 600;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  const int = asInt(value);
  return int !== undefined && int >= 0 ? int : undefined;
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

/** Bound text to the first N lines and M chars, remembering the real size. */
export function boundToolOutput(raw: string | undefined): ToolCallFactsOutput | undefined {
  if (raw === undefined) return undefined;
  const text = stripAnsi(raw).replace(/\r\n?/g, "\n").replace(/\s+$/u, "");
  if (text.length === 0) return undefined;
  const lines = text.split("\n");
  let excerpt = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join("\n");
  let truncated = lines.length > TOOL_OUTPUT_MAX_LINES;
  if (excerpt.length > TOOL_OUTPUT_MAX_CHARS) {
    excerpt = excerpt.slice(0, TOOL_OUTPUT_MAX_CHARS);
    truncated = true;
  }
  return { text: excerpt, lineCount: lines.length, truncated };
}

function boundDiff(diff: string | undefined): string | undefined {
  if (diff === undefined || diff.trim().length === 0) return undefined;
  return diff.length > TOOL_DIFF_MAX_CHARS ? `${diff.slice(0, TOOL_DIFF_MAX_CHARS)}\n` : diff;
}

/** Count `+`/`-` lines of a unified diff, ignoring file headers. */
export function unifiedDiffStat(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Line-level stat for a before/after pair. Uses an LCS on lines for small
 * inputs and falls back to a length difference for large ones so a huge
 * rewrite never stalls ingestion.
 */
export function textPairStat(
  before: string,
  after: string,
): { additions: number; deletions: number } {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.length === 0 ? [] : after.split("\n");
  if (a.length > DIFF_STAT_MAX_LINES || b.length > DIFF_STAT_MAX_LINES) {
    return {
      additions: Math.max(0, b.length - a.length),
      deletions: Math.max(0, a.length - b.length),
    };
  }
  let previous = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = Array.from({ length: b.length + 1 }, () => 0);
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    previous = current;
  }
  const common = previous[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

function fileFact(input: {
  readonly path: string;
  readonly kind?: string | undefined;
  readonly diff?: string | undefined;
  readonly stat?: { additions: number; deletions: number } | undefined;
}): ToolCallFactsFile {
  const stat = input.stat ?? (input.diff ? unifiedDiffStat(input.diff) : undefined);
  const diff = boundDiff(input.diff);
  return {
    path: input.path,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(stat ? { additions: stat.additions, deletions: stat.deletions } : {}),
    ...(diff ? { diff } : {}),
  };
}

function compact(facts: ToolCallFacts): ToolCallFacts | undefined {
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/** Codex app-server items carry everything as typed fields. */
function fromCodex(data: Record<string, unknown>): ToolCallFacts | undefined {
  const item = asRecord(data.item);
  if (!item) return undefined;
  const output = boundToolOutput(asString(item.aggregatedOutput));
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const files = changes.flatMap((change) => {
    const record = asRecord(change);
    const path = asString(record?.path);
    return path
      ? [fileFact({ path, kind: asString(record?.kind), diff: asString(record?.diff) })]
      : [];
  });
  const cwd = asString(item.cwd);
  const exitCode = asInt(item.exitCode);
  const durationMs = asNonNegativeInt(item.durationMs);
  return compact({
    ...(cwd ? { cwd } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(output ? { output } : {}),
    ...(files.length > 0 ? { files } : {}),
  });
}

function claudeResultText(result: unknown): string | undefined {
  const block = asRecord(result);
  const content = block?.content ?? result;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => asString(asRecord(part)?.text))
      .filter((part): part is string => part !== undefined)
      .join("\n");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/**
 * Claude Agent SDK tool calls: `input` is the tool's argument object
 * (`command`/`description` for Bash, `file_path` + `old_string`/`new_string`
 * for Edit, `content` for Write) and `result` is the `tool_result` block.
 */
function fromClaude(data: Record<string, unknown>): ToolCallFacts | undefined {
  const input = asRecord(data.input);
  const intent = asString(input?.description);
  const output = boundToolOutput(claudeResultText(data.result));
  const path = asString(input?.file_path) ?? asString(input?.path);
  const files: ToolCallFactsFile[] = [];
  if (path && input) {
    const before = asString(input.old_string);
    const after = asString(input.new_string);
    const written = asString(input.content);
    if (before !== undefined || after !== undefined) {
      files.push(fileFact({ path, kind: "update", stat: textPairStat(before ?? "", after ?? "") }));
    } else if (written !== undefined) {
      files.push(fileFact({ path, kind: "write", stat: textPairStat("", written) }));
    }
  }
  return compact({
    ...(intent ? { intent } : {}),
    ...(output ? { output } : {}),
    ...(files.length > 0 ? { files } : {}),
  });
}

function acpOutputText(data: Record<string, unknown>): string | undefined {
  const rawOutput = data.rawOutput;
  if (typeof rawOutput === "string") return rawOutput;
  const rawRecord = asRecord(rawOutput);
  const direct =
    asString(rawRecord?.output) ??
    asString(rawRecord?.stdout) ??
    asString(rawRecord?.content) ??
    asString(rawRecord?.stderr);
  if (direct) return direct;
  if (Array.isArray(data.content)) {
    const text = data.content
      .map((entry) => {
        const record = asRecord(entry);
        return record?.type === "content" ? asString(asRecord(record.content)?.text) : undefined;
      })
      .filter((part): part is string => part !== undefined)
      .join("\n");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** ACP (Cursor, Grok): `content[]` carries text and `{type:"diff"}` parts. */
function fromAcp(data: Record<string, unknown>): ToolCallFacts | undefined {
  const output = boundToolOutput(acpOutputText(data));
  const files: ToolCallFactsFile[] = [];
  if (Array.isArray(data.content)) {
    for (const entry of data.content) {
      const record = asRecord(entry);
      const path = asString(record?.path);
      if (record?.type !== "diff" || !path) continue;
      files.push(
        fileFact({
          path,
          stat: textPairStat(asString(record.oldText) ?? "", asString(record.newText) ?? ""),
        }),
      );
    }
  }
  const rawInput = asRecord(data.rawInput);
  const cwd = asString(rawInput?.cwd) ?? asString(rawInput?.workingDirectory);
  const exitCode =
    asInt(asRecord(data.rawOutput)?.exitCode) ?? asInt(asRecord(data.rawOutput)?.exit_code);
  return compact({
    ...(cwd ? { cwd } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(output ? { output } : {}),
    ...(files.length > 0 ? { files } : {}),
  });
}

/** OpenCode: `state` has `input`, `output`/`error`, `metadata`, `time`. */
function fromOpenCode(data: Record<string, unknown>): ToolCallFacts | undefined {
  const state = asRecord(data.state);
  if (!state) return undefined;
  const stateInput = asRecord(state.input);
  const metadata = asRecord(state.metadata);
  const time = asRecord(state.time);
  const start = typeof time?.start === "number" ? time.start : undefined;
  const end = typeof time?.end === "number" ? time.end : undefined;
  const durationMs =
    start !== undefined && end !== undefined && end >= start ? Math.round(end - start) : undefined;
  const output = boundToolOutput(asString(state.output) ?? asString(state.error));
  const exitCode = asInt(metadata?.exit) ?? asInt(metadata?.exitCode);
  const cwd = asString(stateInput?.cwd) ?? asString(stateInput?.workdir);
  const path = asString(stateInput?.filePath) ?? asString(stateInput?.path);
  const files: ToolCallFactsFile[] = [];
  if (path && stateInput) {
    const diff = asString(metadata?.diff);
    const before = asString(stateInput.oldString);
    const after = asString(stateInput.newString);
    const written = asString(stateInput.content);
    if (diff) files.push(fileFact({ path, diff }));
    else if (before !== undefined || after !== undefined) {
      files.push(fileFact({ path, kind: "update", stat: textPairStat(before ?? "", after ?? "") }));
    } else if (written !== undefined) {
      files.push(fileFact({ path, kind: "write", stat: textPairStat("", written) }));
    }
  }
  return compact({
    ...(cwd ? { cwd } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(output ? { output } : {}),
    ...(files.length > 0 ? { files } : {}),
  });
}

export function deriveToolCallFacts(input: {
  readonly provider: ProviderDriverKind | string;
  readonly data: unknown;
}): ToolCallFacts | undefined {
  const data = asRecord(input.data);
  if (!data) return undefined;
  switch (input.provider) {
    case "codex":
      return fromCodex(data);
    case "claudeAgent":
      return fromClaude(data);
    case "cursor":
    case "grok":
      return fromAcp(data);
    case "opencode":
      return fromOpenCode(data);
    default:
      return undefined;
  }
}
