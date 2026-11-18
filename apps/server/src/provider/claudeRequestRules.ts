import type {
  RequestRewriteRule,
  RequestRewriteRuleReport,
  RequestRewriteWarning,
} from "@t3tools/contracts";

const BILLING_PREFIX = "x-anthropic-billing-header:";
const REMINDER_PREFIX = "<system-reminder>";
const MAX_SNIPPETS = 2;
const SNIPPET_LEAD = 40;
const SNIPPET_LENGTH = 240;

export interface ClaudeRequestRewrite {
  /** The body to send: the original string when nothing changed. */
  readonly body: string;
  readonly changed: boolean;
  readonly skipped?: "other-request" | "not-json" | "unexpected-body";
  readonly rules: ReadonlyArray<RequestRewriteRuleReport>;
}

type JsonObject = Record<string, unknown>;

interface Tally {
  blocks: number;
  removedChars: number;
  addedChars: number;
  changed: boolean;
  cacheTouched: boolean;
  readonly snippets: Array<{ readonly before: string; readonly after: string }>;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBlank = (text: string) => text.trim().length === 0;

const textOf = (block: unknown): string | undefined =>
  isObject(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : undefined;

export const isClaudeMessagesRequest = (method: string, path: string): boolean =>
  method === "POST" && new URL(path, "http://localhost").pathname === "/v1/messages";

/** A short excerpt of each side, starting just before the first character that differs. */
function snippet(before: string, after: string) {
  let same = 0;
  while (same < before.length && same < after.length && before[same] === after[same]) same += 1;
  const from = Math.max(0, same - SNIPPET_LEAD);
  const cut = (text: string) =>
    (from > 0 ? "…" : "") +
    text.slice(from, from + SNIPPET_LENGTH) +
    (text.length > from + SNIPPET_LENGTH ? "…" : "");
  return { before: cut(before), after: cut(after) };
}

function record(tally: Tally, before: string, after: string) {
  tally.changed = true;
  if (tally.snippets.length < MAX_SNIPPETS) tally.snippets.push(snippet(before, after));
}

function makeEdit(pattern: RegExp, replacement: string, tally: Tally) {
  return (text: string): string => {
    let removed = 0;
    pattern.lastIndex = 0;
    text.replace(pattern, (match) => {
      removed += match.length;
      return match;
    });
    pattern.lastIndex = 0;
    const next = text.replace(pattern, replacement);
    if (next === text) return text;
    tally.blocks += 1;
    tally.removedChars += removed;
    tally.addedChars += next.length - text.length + removed;
    record(tally, text, next);
    return next;
  };
}

// A string system prompt or message content is one text block.
const asBlocks = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : typeof value === "string" ? [{ type: "text", text: value }] : [];

/** Edits each selected text block; a block left blank is dropped. */
function editBlocks(
  blocks: ReadonlyArray<unknown>,
  select: (text: string) => boolean,
  edit: (text: string) => string,
  tally: Tally,
): ReadonlyArray<unknown> | undefined {
  let changed = false;
  const out: Array<unknown> = [];
  for (const block of blocks) {
    const text = textOf(block);
    if (!isObject(block) || text === undefined || !select(text)) {
      out.push(block);
      continue;
    }
    const next = edit(text);
    if (next === text) {
      out.push(block);
      continue;
    }
    changed = true;
    if (block.cache_control !== undefined) tally.cacheTouched = true;
    if (!isBlank(next)) out.push({ ...block, text: next });
  }
  return changed ? out : undefined;
}

function editMessages(
  body: JsonObject,
  select: (text: string) => boolean,
  edit: (text: string) => string,
  tally: Tally,
) {
  if (!Array.isArray(body.messages)) return;
  const messages: Array<unknown> = [];
  for (const message of body.messages) {
    const content = isObject(message) ? message.content : undefined;
    const next =
      isObject(message) && (typeof content === "string" || Array.isArray(content))
        ? editBlocks(asBlocks(content), select, edit, tally)
        : undefined;
    if (!isObject(message) || next === undefined) messages.push(message);
    else if (next.length > 0) {
      messages.push({ ...message, content: typeof content === "string" ? textOf(next[0]) : next });
    }
  }
  body.messages = messages;
}

function editTools(body: JsonObject, edit: (text: string) => string, tally: Tally) {
  if (!Array.isArray(body.tools)) return;
  body.tools = body.tools.map((tool: unknown) => {
    if (!isObject(tool) || typeof tool.description !== "string") return tool;
    const next = edit(tool.description);
    if (next === tool.description) return tool;
    if (tool.cache_control !== undefined) tally.cacheTouched = true;
    if (!isBlank(next)) return { ...tool, description: next };
    const { description: _description, ...rest } = tool;
    return rest;
  });
}

function addText(body: JsonObject, rule: RequestRewriteRule, tally: Tally) {
  const text = rule.text ?? "";
  if (isBlank(text)) return;
  const block = { type: "text", text };
  if (rule.target === "system") {
    body.system = [...asBlocks(body.system), block];
  } else {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const index = messages.findLastIndex(
      (message: unknown) => isObject(message) && message.role === "user",
    );
    const message: unknown = messages[index];
    if (!isObject(message)) return;
    messages[index] = { ...message, content: [...asBlocks(message.content), block] };
  }
  tally.blocks += 1;
  tally.addedChars += text.length;
  record(tally, "", text);
}

function applyRule(
  body: JsonObject,
  rule: RequestRewriteRule,
  tally: Tally,
): RequestRewriteRuleReport["error"] {
  if (rule.action === "add") {
    if (rule.target === "tools") return "add-to-tools";
    addText(body, rule, tally);
    return undefined;
  }
  if (rule.pattern === undefined || rule.pattern.length === 0) return "missing-pattern";
  let pattern: RegExp;
  try {
    pattern = new RegExp(rule.pattern, rule.flags ?? "g");
  } catch {
    return "invalid-pattern";
  }
  const edit = makeEdit(pattern, rule.action === "replace" ? (rule.text ?? "") : "", tally);
  switch (rule.target) {
    case "system": {
      const next = editBlocks(asBlocks(body.system), () => true, edit, tally);
      if (next !== undefined) body.system = next;
      return undefined;
    }
    case "reminders":
      editMessages(body, (text) => text.trimStart().startsWith(REMINDER_PREFIX), edit, tally);
      return undefined;
    case "messages":
      editMessages(body, () => true, edit, tally);
      return undefined;
    case "tools":
      editTools(body, edit, tally);
      return undefined;
  }
}

// The provider accepts a request whose first system block is Claude Code's billing header or
// its identity line, unchanged. A fitted rule from experiments, not documented behaviour.
function firstSystemAnchors(body: JsonObject): ReadonlySet<string> {
  const [first, second] = asBlocks(body.system).map(textOf);
  if (first === undefined) return new Set();
  if (!first.startsWith(BILLING_PREFIX) || second === undefined) return new Set([first]);
  return new Set([first, second]);
}

function firstSystemState(body: JsonObject, anchors: ReadonlySet<string>) {
  const blocks = asBlocks(body.system);
  if (blocks.length === 0) return "none";
  const first = textOf(blocks[0]);
  return first !== undefined && anchors.has(first) ? "anchored" : "other";
}

/**
 * Applies `rules` in order to one request Claude Code sends. Only `POST /v1/messages` bodies are
 * rewritten; anything else, or a body that is not the expected JSON, comes back unchanged with
 * `skipped` set. A rule that cannot run reports an error and is skipped; this never throws.
 */
export function rewriteClaudeRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly rules: ReadonlyArray<RequestRewriteRule>;
}): ClaudeRequestRewrite {
  if (!isClaudeMessagesRequest(input.method, input.path)) {
    return { body: input.body, changed: false, skipped: "other-request", rules: [] };
  }
  if (input.rules.length === 0) return { body: input.body, changed: false, rules: [] };
  let body: unknown;
  try {
    body = JSON.parse(input.body);
  } catch {
    return { body: input.body, changed: false, skipped: "not-json", rules: [] };
  }
  if (!isObject(body) || !Array.isArray(body.messages)) {
    return { body: input.body, changed: false, skipped: "unexpected-body", rules: [] };
  }
  const anchors = firstSystemAnchors(body);
  let changed = false;
  const reports: Array<RequestRewriteRuleReport> = [];
  for (const rule of input.rules) {
    const tally: Tally = {
      blocks: 0,
      removedChars: 0,
      addedChars: 0,
      changed: false,
      cacheTouched: false,
      snippets: [],
    };
    const before = firstSystemState(body, anchors);
    const error = applyRule(body, rule, tally);
    const after = firstSystemState(body, anchors);
    const warnings: Array<RequestRewriteWarning> = [];
    if (before !== "none" && after === "none") warnings.push("system-removed");
    if (before === "anchored" && after === "other") warnings.push("first-system-block");
    if (tally.cacheTouched) warnings.push("cache-breakpoint");
    changed ||= tally.changed;
    reports.push({
      ruleId: rule.id,
      name: rule.name,
      blocks: tally.blocks,
      removedChars: tally.removedChars,
      addedChars: tally.addedChars,
      warnings,
      ...(error === undefined ? {} : { error }),
      snippets: tally.snippets,
    });
  }
  // A later rule can undo what an earlier one broke; only what the sent request shows counts.
  const final = firstSystemState(body, anchors);
  const rules = reports.map((report) => ({
    ...report,
    warnings: report.warnings.filter(
      (warning) =>
        warning === "cache-breakpoint" ||
        (warning === "system-removed" ? final === "none" : final === "other"),
    ),
  }));
  return changed
    ? { body: JSON.stringify(body), changed, rules }
    : { body: input.body, changed, rules };
}
