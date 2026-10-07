// @effect-diagnostics globalDate:off -- Qualifier dates use the user's local calendar and test-injected Date.

export type ThreadSearchQualifierKey =
  | "project"
  | "env"
  | "branch"
  | "provider"
  | "status"
  | "since"
  | "before";

export type ThreadSearchQualifierToggleKey = ThreadSearchQualifierKey | "archived";

export const THREAD_SEARCH_QUALIFIER_KEYS = [
  "project",
  "env",
  "branch",
  "provider",
  "status",
  "since",
  "before",
] as const satisfies ReadonlyArray<ThreadSearchQualifierKey>;

export interface ThreadSearchClause {
  readonly values: ReadonlyArray<string>;
  readonly negated: boolean;
}

export interface ThreadSearchFilters {
  readonly project: ReadonlyArray<ThreadSearchClause>;
  readonly env: ReadonlyArray<ThreadSearchClause>;
  readonly branch: ReadonlyArray<ThreadSearchClause>;
  readonly provider: ReadonlyArray<ThreadSearchClause>;
  readonly status: ReadonlyArray<ThreadSearchClause>;
  readonly since: ReadonlyArray<ThreadSearchClause>;
  readonly before: ReadonlyArray<ThreadSearchClause>;
  readonly archived: boolean;
}

export interface ParsedThreadSearchQuery {
  readonly text: string;
  readonly filters: ThreadSearchFilters;
  readonly hasFilters: boolean;
}

export interface ThreadSearchMatchContext<T = unknown> {
  readonly projectNames: (thread: T) => ReadonlyArray<string>;
  readonly environmentNames: (thread: T) => ReadonlyArray<string>;
  readonly providerNames: (thread: T) => ReadonlyArray<string>;
  readonly statusNames: (thread: T) => ReadonlyArray<string>;
  readonly activityAt: (thread: T) => string;
}

const STATUS_ALIASES: Readonly<Record<string, string>> = {
  pending: "approval",
  awaiting: "input",
  error: "failed",
  done: "ready",
  completed: "ready",
};
const STATUS_VALUES = new Set([
  "working",
  "approval",
  "input",
  "waiting",
  "failed",
  "limited",
  "ready",
  ...Object.keys(STATUS_ALIASES),
]);
const KEY_ALIASES: Readonly<Record<string, ThreadSearchQualifierKey>> = {
  project: "project",
  env: "env",
  environment: "env",
  branch: "branch",
  provider: "provider",
  status: "status",
  since: "since",
  before: "before",
};

interface QueryToken {
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

interface ClassifiedQueryToken {
  readonly key: ThreadSearchQualifierToggleKey;
  readonly values: ReadonlyArray<string>;
  readonly negated: boolean;
}

function tokenizeWithRaw(raw: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const input = raw.trim();
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) index += 1;
    if (index >= input.length) break;

    const start = index;
    let quoted = false;
    while (index < input.length) {
      const character = input[index]!;
      if (character === '"' && input[index - 1] !== "\\") {
        if (!quoted) {
          // An unmatched opening quote is ordinary text. This preserves the
          // existing token behaviour for incomplete input while allowing
          // quoted values to contain spaces.
          quoted = input.slice(index + 1).includes('"');
          if (!quoted) {
            index += 1;
            continue;
          }
        } else {
          quoted = false;
          index += 1;
          continue;
        }
      }
      if (!quoted && /\s/.test(character)) break;
      index += 1;
    }
    tokens.push({ raw: input.slice(start, index), start, end: index });
    while (index < input.length && /\s/.test(input[index]!)) index += 1;
  }
  return tokens;
}

function splitCommaValues(raw: string): string[] | null {
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === '"' && raw[index - 1] !== "\\") {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted) return null;
  values.push(raw.slice(start));
  return values;
}

function unquoteValue(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!value.startsWith('"')) return value.includes('"') ? null : value;
  if (!value.endsWith('"') || value.length < 2) return null;
  const inner = value.slice(1, -1);
  return inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function parseQualifierValues(raw: string): string[] | null {
  const parts = splitCommaValues(raw);
  if (parts === null) return null;
  const values = parts.map(unquoteValue);
  return values.every((value): value is string => value !== null && value.length > 0)
    ? values
    : null;
}

function startOfLocalDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function parseDate(value: string, now: Date): number | null {
  const lower = value.toLowerCase();
  if (lower === "today") return startOfLocalDay(now).getTime();
  if (lower === "yesterday") {
    const result = startOfLocalDay(now);
    result.setDate(result.getDate() - 1);
    return result.getTime();
  }
  const relative = /^(\d+)([hdw])$/i.exec(lower);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const milliseconds =
      unit === "h" ? amount * 3_600_000 : unit === "d" ? amount * 86_400_000 : amount * 604_800_000;
    return now.getTime() - milliseconds;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(now);
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setHours(0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
    ? null
    : date.getTime();
}

function validValues(key: ThreadSearchQualifierKey, rawValue: string, now: Date): string[] | null {
  const values = parseQualifierValues(rawValue);
  if (values === null) return null;
  if (key === "status") {
    if (values.some((part) => !STATUS_VALUES.has(part.toLowerCase()))) return null;
    return values.map((part) => STATUS_ALIASES[part.toLowerCase()] ?? part.toLowerCase());
  }
  if ((key === "since" || key === "before") && values.some((part) => parseDate(part, now) === null))
    return null;
  return values;
}

function classifyToken(token: QueryToken, now: Date): ClassifiedQueryToken | null {
  const raw = token.raw;
  if (raw.startsWith('"')) return null;
  const negated = raw.startsWith("-");
  const candidate = negated ? raw.slice(1) : raw;
  if (candidate.toLowerCase() === "is:archived") {
    return { key: "archived", values: ["archived"], negated };
  }
  const separator = candidate.indexOf(":");
  if (separator <= 0) return null;
  const key = KEY_ALIASES[candidate.slice(0, separator).toLowerCase()];
  if (key === undefined) return null;
  const values = validValues(key, candidate.slice(separator + 1), now);
  return values === null ? null : { key, values, negated };
}

// Keep surviving text runs intact; only replace gaps created by removed qualifiers.
function removeTokenSpans(
  raw: string,
  tokens: ReadonlyArray<QueryToken>,
  remove: (index: number) => boolean,
): string {
  const runs: string[] = [];
  let runStart = 0;
  for (const [index, token] of tokens.entries()) {
    if (!remove(index)) continue;
    const run = raw.slice(runStart, token.start).trim();
    if (run) runs.push(run);
    runStart = token.end;
  }
  const tail = raw.slice(runStart).trim();
  if (tail) runs.push(tail);
  return runs.join(" ");
}

export function parseThreadSearchQuery(
  raw: string,
  options: { readonly now: Date },
): ParsedThreadSearchQuery {
  const tokens = tokenizeWithRaw(raw);
  const classified = tokens.map((token) => classifyToken(token, options.now));
  const filters: Record<ThreadSearchQualifierKey, ThreadSearchClause[]> = {
    project: [],
    env: [],
    branch: [],
    provider: [],
    status: [],
    since: [],
    before: [],
  };
  let archived = false;
  let hasFilters = false;
  for (const token of classified) {
    if (token == null) continue;
    if (token.key === "archived") {
      if (!token.negated) archived = true;
      hasFilters = true;
      continue;
    }
    filters[token.key].push({ values: token.values, negated: token.negated });
    hasFilters = true;
  }
  const text = removeTokenSpans(raw.trim(), tokens, (index) => classified[index] !== null);
  return { text, filters: { ...filters, archived }, hasFilters };
}

function formatQualifierValue(value: string): string {
  return /[\s,"]/.test(value)
    ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : value;
}

function formatQualifier(
  key: ThreadSearchQualifierToggleKey,
  values: ReadonlyArray<string>,
): string {
  if (key === "archived") return "is:archived";
  return `${key}:${values.map(formatQualifierValue).join(",")}`;
}

/** Toggle one positive qualifier while preserving free text and negated tokens. */
export function toggleThreadSearchQualifier(
  query: string,
  key: ThreadSearchQualifierToggleKey,
  value: string,
  options: { readonly multi: boolean },
): string {
  const tokens = tokenizeWithRaw(query);
  const now = new Date();
  const classified = tokens.map((token) => classifyToken(token, now));
  const positiveIndexes = classified.flatMap((token, index) =>
    token?.key === key && !token.negated ? [index] : [],
  );
  const valueIndex = positiveIndexes.find((index) =>
    classified[index]?.values.some((candidate) => candidate.toLowerCase() === value.toLowerCase()),
  );
  const output: string[] = [];

  if (valueIndex !== undefined) {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = classified[index];
      if (index !== valueIndex || token == null) {
        output.push(tokens[index]!.raw);
        continue;
      }
      const values = token.values.filter(
        (candidate) => candidate.toLowerCase() !== value.toLowerCase(),
      );
      if (values.length > 0) output.push(formatQualifier(key, values));
    }
    return output.join(" ");
  }

  const targetIndex = options.multi ? positiveIndexes.at(-1) : positiveIndexes[0];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = classified[index];
    if (token?.key !== key || token.negated) {
      output.push(tokens[index]!.raw);
      continue;
    }
    if (index !== targetIndex) {
      if (options.multi) output.push(tokens[index]!.raw);
      continue;
    }
    output.push(formatQualifier(key, options.multi ? [...token.values, value] : [value]));
  }
  if (targetIndex === undefined) output.push(formatQualifier(key, [value]));
  return output.join(" ");
}

/** Remove all recognized qualifiers, leaving unknown tokens and free text intact. */
export function clearThreadSearchQualifiers(query: string): string {
  const tokens = tokenizeWithRaw(query);
  const now = new Date();
  return removeTokenSpans(
    query.trim(),
    tokens,
    (index) => classifyToken(tokens[index]!, now) !== null,
  );
}

function matchesClauses(
  names: ReadonlyArray<string>,
  clauses: ReadonlyArray<ThreadSearchClause>,
): boolean {
  return clauses.every((clause) => {
    const matched = clause.values.some((candidate) =>
      names.some((name) => name.toLocaleLowerCase().includes(candidate.toLocaleLowerCase())),
    );
    return clause.negated ? !matched : matched;
  });
}

function matchesDateClause(
  activityAt: string,
  clause: ThreadSearchClause,
  now: Date,
  before: boolean,
): boolean {
  const timestamp = Date.parse(activityAt);
  if (Number.isNaN(timestamp)) return false;
  const matched = clause.values.some((value) => {
    const boundary = parseDate(value, now);
    if (boundary === null) return false;
    return before ? timestamp < boundary : timestamp >= boundary;
  });
  return clause.negated ? !matched : matched;
}

export function getThreadSearchProjectNames(
  project: { readonly title: string; readonly workspaceRoot: string } | null | undefined,
  groupedLabel?: string | null,
): ReadonlyArray<string> {
  const names = [
    project?.title ?? "",
    project?.workspaceRoot.split(/[\\/]/).pop() ?? "",
    groupedLabel ?? "",
  ];
  return [...new Set(names.filter((name) => name.length > 0))];
}

export function matchesThreadSearchFilters<T extends { readonly branch: string | null }>(
  thread: T,
  filters: ThreadSearchFilters,
  context: ThreadSearchMatchContext<T>,
  options: { readonly now: Date },
): boolean {
  if (filters.project.length > 0 && !matchesClauses(context.projectNames(thread), filters.project))
    return false;
  if (filters.env.length > 0 && !matchesClauses(context.environmentNames(thread), filters.env))
    return false;
  if (!matchesClauses([thread.branch ?? ""], filters.branch)) return false;
  if (
    filters.provider.length > 0 &&
    !matchesClauses(context.providerNames(thread), filters.provider)
  )
    return false;
  if (filters.status.length > 0 && !matchesClauses(context.statusNames(thread), filters.status))
    return false;
  if (
    !filters.since.every((clause) =>
      matchesDateClause(context.activityAt(thread), clause, options.now, false),
    )
  )
    return false;
  if (
    !filters.before.every((clause) =>
      matchesDateClause(context.activityAt(thread), clause, options.now, true),
    )
  )
    return false;
  return true;
}

export function sortThreadsByActivity<
  T extends { readonly updatedAt: string; readonly latestUserMessageAt?: string | null },
>(threads: ReadonlyArray<T>): T[] {
  return [...threads].sort((left, right) =>
    (right.latestUserMessageAt ?? right.updatedAt).localeCompare(
      left.latestUserMessageAt ?? left.updatedAt,
    ),
  );
}
