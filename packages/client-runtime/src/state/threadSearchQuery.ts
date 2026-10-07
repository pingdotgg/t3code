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
  readonly projectName: (thread: T) => string;
  readonly environmentNames: (thread: T) => ReadonlyArray<string>;
  readonly providerNames: (thread: T) => ReadonlyArray<string>;
  readonly status: (thread: T) => string;
  readonly activityAt: (thread: T) => string;
}

const STATUS_VALUES = new Set([
  "working",
  "approval",
  "pending",
  "input",
  "awaiting",
  "waiting",
  "failed",
  "error",
  "limited",
  "ready",
  "done",
  "completed",
]);
const STATUS_ALIASES: Readonly<Record<string, string>> = {
  pending: "approval",
  awaiting: "input",
  error: "failed",
  done: "ready",
  completed: "ready",
};
const DATE_PATTERN = /^(?:\d{4}-\d{2}-\d{2}|\d+[hdw]|today|yesterday)$/i;
const KEY_ALIASES: Readonly<Record<string, ThreadSearchQualifierKey>> = {
  project: "project",
  in: "project",
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
  readonly value: string;
}

function tokenizeWithRaw(raw: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const input = raw.trim();
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) index += 1;
    if (index >= input.length) break;

    const start = index;
    let token = "";
    let quoted = false;
    while (index < input.length) {
      const character = input[index]!;
      if (character === '"' && !quoted) {
        if (input.indexOf('"', index + 1) !== -1) {
          quoted = true;
          index += 1;
          continue;
        }
        // An unmatched quote is ordinary text. Backslashes and apostrophes
        // are ordinary text in every mode.
        token += character;
        index += 1;
        continue;
      }
      if (character === '"' && quoted) {
        quoted = false;
        index += 1;
        continue;
      }
      if (!quoted && /\s/.test(character)) break;
      token += character;
      index += 1;
    }
    tokens.push({ raw: input.slice(start, index), value: token });
    while (index < input.length && /\s/.test(input[index]!)) index += 1;
  }
  return tokens;
}

function tokenize(raw: string): string[] {
  return tokenizeWithRaw(raw)
    .map((token) => token.value)
    .filter(Boolean);
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

function validValues(key: ThreadSearchQualifierKey, value: string, now: Date): string[] | null {
  if (value.includes('"')) return null;
  const values = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (values.length === 0) return null;
  if (key === "status") {
    if (values.some((part) => !STATUS_VALUES.has(part.toLowerCase()))) return null;
    return values.map((part) => STATUS_ALIASES[part.toLowerCase()] ?? part.toLowerCase());
  }
  if (
    (key === "since" || key === "before") &&
    values.some((part) => !DATE_PATTERN.test(part) || parseDate(part, now) === null)
  )
    return null;
  return values;
}

export function parseThreadSearchQuery(
  raw: string,
  options: { readonly now: Date },
): ParsedThreadSearchQuery {
  const filters: Record<ThreadSearchQualifierKey, ThreadSearchClause[]> = {
    project: [],
    env: [],
    branch: [],
    provider: [],
    status: [],
    since: [],
    before: [],
  };
  const text: string[] = [];
  let archived = false;
  let hasFilters = false;
  for (const token of tokenize(raw)) {
    const negated = token.startsWith("-");
    const candidate = negated ? token.slice(1) : token;
    const separator = candidate.indexOf(":");
    const key =
      separator > 0 ? KEY_ALIASES[candidate.slice(0, separator).toLowerCase()] : undefined;
    const value = separator > 0 ? candidate.slice(separator + 1) : "";
    if (candidate.toLowerCase() === "is:archived") {
      if (!negated) {
        archived = true;
        hasFilters = true;
      }
      continue;
    }
    if (key !== undefined) {
      const values = validValues(key, value, options.now);
      if (values !== null) {
        filters[key].push({ values, negated });
        hasFilters = true;
        continue;
      }
    }
    text.push(token);
  }
  return { text: text.join(" "), filters: { ...filters, archived }, hasFilters };
}

interface RecognizedQueryToken {
  readonly key: ThreadSearchQualifierToggleKey;
  readonly values: ReadonlyArray<string>;
  readonly negated: boolean;
}

function recognizedQueryToken(token: QueryToken): RecognizedQueryToken | null {
  const negated = token.value.startsWith("-");
  const candidate = negated ? token.value.slice(1) : token.value;
  if (candidate.toLowerCase() === "is:archived") {
    return { key: "archived", values: ["archived"], negated };
  }
  const separator = candidate.indexOf(":");
  if (separator <= 0) return null;
  const key = KEY_ALIASES[candidate.slice(0, separator).toLowerCase()];
  if (key === undefined) return null;
  // Editing validates date syntax, without resolving boundaries against the current time.
  const values = validValues(key, candidate.slice(separator + 1), new Date(0));
  return values === null ? null : { key, values, negated };
}

function formatQualifierValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
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
  const recognized = tokens.map(recognizedQueryToken);
  const positiveIndexes = recognized.flatMap((token, index) =>
    token?.key === key && !token.negated ? [index] : [],
  );
  const existingValues = positiveIndexes.flatMap((index) => recognized[index]?.values ?? []);
  const hasValue = existingValues.some(
    (candidate) => candidate.toLowerCase() === value.toLowerCase(),
  );
  const nextValues = hasValue
    ? existingValues.filter((candidate) => candidate.toLowerCase() !== value.toLowerCase())
    : options.multi
      ? [...existingValues, value]
      : [value];
  const output: string[] = [];
  const firstPositiveIndex = positiveIndexes[0];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = recognized[index];
    if (token?.key !== key || token.negated) {
      output.push(tokens[index]!.raw);
      continue;
    }
    if (index !== firstPositiveIndex) continue;
    if (nextValues.length > 0) output.push(formatQualifier(key, nextValues));
  }
  if (positiveIndexes.length === 0 && !hasValue) output.push(formatQualifier(key, [value]));
  return output.join(" ");
}

/** Remove all recognized qualifiers, leaving unknown tokens and free text intact. */
export function clearThreadSearchQualifiers(query: string): string {
  return tokenizeWithRaw(query)
    .filter((token) => recognizedQueryToken(token) === null)
    .map((token) => token.raw)
    .join(" ");
}

function matchesClause(value: string, clause: ThreadSearchClause): boolean {
  const matched = clause.values.some((candidate) =>
    value.toLocaleLowerCase().includes(candidate.toLocaleLowerCase()),
  );
  return clause.negated ? !matched : matched;
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

export function matchesThreadSearchFilters<
  T extends { readonly updatedAt: string; readonly branch: string | null },
>(
  thread: T,
  filters: ThreadSearchFilters,
  context: ThreadSearchMatchContext<T>,
  options: { readonly now: Date },
): boolean {
  const match = (clauses: ReadonlyArray<ThreadSearchClause>, value: string) =>
    clauses.every((clause) => matchesClause(value, clause));
  if (filters.project.length > 0 && !match(filters.project, context.projectName(thread)))
    return false;
  const environmentNames = filters.env.length > 0 ? context.environmentNames(thread) : [];
  if (
    !filters.env.every((clause) => {
      const matched = clause.values.some((value) =>
        environmentNames.some((name) =>
          name.toLocaleLowerCase().includes(value.toLocaleLowerCase()),
        ),
      );
      return clause.negated ? !matched : matched;
    })
  )
    return false;
  if (!match(filters.branch, thread.branch ?? "")) return false;
  const providerNames = filters.provider.length > 0 ? context.providerNames(thread) : [];
  if (
    !filters.provider.every((clause) => {
      const matched = clause.values.some((value) =>
        providerNames.some((name) => name.toLocaleLowerCase().includes(value.toLocaleLowerCase())),
      );
      return clause.negated ? !matched : matched;
    })
  )
    return false;
  if (filters.status.length > 0 && !match(filters.status, context.status(thread))) return false;
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
