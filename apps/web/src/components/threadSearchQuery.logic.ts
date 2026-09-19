// ── Thread search query language ─────────────────────────────────────
// Discord-style operators over the already-synced shell data, used by the
// command palette's thread search:
//   in:<project>      scope to projects whose name or path contains the value
//   agent:<provider>  provider name / instance id substring
//   before: after:    updatedAt bounds — ISO day, or relative like 7d / 2w
//   on:               one calendar day — ISO day, today, yesterday
// Everything else remains free text. Operators AND together; repeated values
// of the same operator OR within it. Values with spaces are quoted:
// in:"My Project". An operator token whose value doesn't parse (bad date)
// degrades to plain text instead of silently filtering everything out.

export interface ParsedThreadSearchQuery {
  /** Lowercased free text left after operator extraction. */
  readonly text: string;
  /** Lowercased in: values. Project-key resolution happens in the caller
      (via resolveProjectFilterKeys) because group names live outside the
      thread shells. */
  readonly projectQueries: readonly string[];
  /** Lowercased agent: values. */
  readonly agentQueries: readonly string[];
  /** Half-open [start, end) bounds on updatedAt, merged across all date
      operators; null side = unbounded. */
  readonly updatedStartMs: number | null;
  readonly updatedEndMs: number | null;
}

const SEARCH_OPERATOR_PATTERN = /^(in|agent|before|after|on):(.*)$/i;
const DAY_MS = 86_400_000;

/** Splits on whitespace, except inside double quotes (an unterminated quote
    runs to the end — that's just a user mid-typing). */
function tokenizeSearchQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of query) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function unquoteSearchValue(value: string): string {
  return value.replace(/^"/, "").replace(/"$/, "");
}

type SearchDateToken =
  | { readonly kind: "instant"; readonly ms: number }
  | { readonly kind: "day"; readonly startMs: number; readonly endMs: number };

/** Local-calendar day math goes through the Date constructor (day ± 1) so
    month rollover and DST transitions resolve correctly. */
function localDayRange(year: number, monthIndex: number, day: number): SearchDateToken {
  return {
    kind: "day",
    startMs: new Date(year, monthIndex, day).getTime(),
    endMs: new Date(year, monthIndex, day + 1).getTime(),
  };
}

function resolveSearchDateToken(rawValue: string, now: Date): SearchDateToken | null {
  const value = rawValue.toLowerCase();
  const relative = /^(\d{1,4})([dw])$/.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === "w" ? 7 * DAY_MS : DAY_MS;
    return { kind: "instant", ms: now.getTime() - amount * unitMs };
  }
  if (value === "today" || value === "yesterday") {
    const offset = value === "yesterday" ? 1 : 0;
    return localDayRange(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  }
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoDay) {
    const year = Number(isoDay[1]);
    const monthIndex = Number(isoDay[2]) - 1;
    const day = Number(isoDay[3]);
    const start = new Date(year, monthIndex, day);
    // The Date constructor rolls invalid components over (2026-02-31 →
    // March 3rd); a rolled-over date is a typo, not a filter.
    if (
      start.getFullYear() !== year ||
      start.getMonth() !== monthIndex ||
      start.getDate() !== day
    ) {
      return null;
    }
    return localDayRange(year, monthIndex, day);
  }
  return null;
}

export function parseThreadSearchQuery(query: string, now: Date): ParsedThreadSearchQuery {
  const textTokens: string[] = [];
  const projectQueries: string[] = [];
  const agentQueries: string[] = [];
  let updatedStartMs: number | null = null;
  let updatedEndMs: number | null = null;
  const tightenStart = (ms: number) => {
    updatedStartMs = updatedStartMs === null ? ms : Math.max(updatedStartMs, ms);
  };
  const tightenEnd = (ms: number) => {
    updatedEndMs = updatedEndMs === null ? ms : Math.min(updatedEndMs, ms);
  };

  for (const token of tokenizeSearchQuery(query)) {
    const operator = SEARCH_OPERATOR_PATTERN.exec(token);
    if (!operator) {
      textTokens.push(token);
      continue;
    }
    const keyword = operator[1]!.toLowerCase();
    const value = unquoteSearchValue(operator[2]!).trim().toLowerCase();
    // A bare `in:` is someone mid-typing (the autocomplete is open); an
    // empty value must not filter anything.
    if (value.length === 0) continue;
    if (keyword === "in") {
      projectQueries.push(value);
      continue;
    }
    if (keyword === "agent") {
      agentQueries.push(value);
      continue;
    }
    const dateToken = resolveSearchDateToken(value, now);
    if (dateToken === null) {
      textTokens.push(token);
      continue;
    }
    // before: excludes the named day/instant; after: starts past it; on:
    // pins both bounds to the day. All merge by intersection.
    if (keyword === "before") {
      tightenEnd(dateToken.kind === "instant" ? dateToken.ms : dateToken.startMs);
    } else if (keyword === "after") {
      tightenStart(dateToken.kind === "instant" ? dateToken.ms : dateToken.endMs);
    } else if (dateToken.kind === "day") {
      tightenStart(dateToken.startMs);
      tightenEnd(dateToken.endMs);
    } else {
      // on:7d is a point, not a day — degrade to text like other bad dates.
      textTokens.push(token);
    }
  }

  return {
    text: textTokens.join(" ").toLowerCase(),
    projectQueries,
    agentQueries,
    updatedStartMs,
    updatedEndMs,
  };
}

/** Whether the parsed query carries any OPERATOR criteria (project, agent,
    or date bounds) — free text alone doesn't count. */
export function hasThreadSearchOperators(parsed: ParsedThreadSearchQuery): boolean {
  return (
    parsed.projectQueries.length > 0 ||
    parsed.agentQueries.length > 0 ||
    parsed.updatedStartMs !== null ||
    parsed.updatedEndMs !== null
  );
}

export interface OperatorSearchableThread {
  readonly title: string;
  readonly updatedAt: string;
  readonly modelSelection: { readonly instanceId: string };
  readonly session: {
    readonly providerName: string | null;
    readonly providerInstanceId?: string | undefined;
  } | null;
}

/**
 * Applies the parsed query's OPERATOR criteria (agent, date bounds) plus the
 * free text against the thread title. Callers that rank text against richer
 * haystacks (project title, content snippets) pass `{ ...parsed, text: "" }`
 * and match the text themselves. The in: operator is applied separately as a
 * project-key filter — thread shells don't carry project names.
 */
export function matchesParsedThreadSearch(
  thread: OperatorSearchableThread,
  parsed: ParsedThreadSearchQuery,
): boolean {
  if (parsed.text.length > 0 && !thread.title.toLowerCase().includes(parsed.text)) {
    return false;
  }
  if (parsed.agentQueries.length > 0) {
    const agentHaystack = [
      thread.session?.providerName,
      thread.session?.providerInstanceId,
      thread.modelSelection.instanceId,
    ]
      .filter((candidate): candidate is string => typeof candidate === "string")
      .join(" ")
      .toLowerCase();
    if (!parsed.agentQueries.some((query) => agentHaystack.includes(query))) {
      return false;
    }
  }
  if (parsed.updatedStartMs !== null || parsed.updatedEndMs !== null) {
    const updatedMs = Date.parse(thread.updatedAt);
    if (Number.isNaN(updatedMs)) return false;
    if (parsed.updatedStartMs !== null && updatedMs < parsed.updatedStartMs) return false;
    if (parsed.updatedEndMs !== null && updatedMs >= parsed.updatedEndMs) return false;
  }
  return true;
}

export interface ThreadSearchProjectGroup {
  readonly projectKey: string;
  readonly displayName: string;
  readonly workspaceRoot: string;
  readonly memberProjectRefs: readonly {
    readonly environmentId: string;
    readonly projectId: string;
  }[];
}

/** Expands in: values into the `${environmentId}:${projectId}` key set the
    clients already filter by. null = no in: filter; an empty set means the
    values matched no project (zero results, not all results). */
export function resolveProjectFilterKeys(
  groups: readonly ThreadSearchProjectGroup[],
  projectQueries: readonly string[],
): ReadonlySet<string> | null {
  if (projectQueries.length === 0) return null;
  const keys = new Set<string>();
  for (const group of groups) {
    const name = group.displayName.toLowerCase();
    const root = group.workspaceRoot.toLowerCase();
    if (projectQueries.some((query) => name.includes(query) || root.includes(query))) {
      for (const ref of group.memberProjectRefs) {
        keys.add(`${ref.environmentId}:${ref.projectId}`);
      }
    }
  }
  return keys;
}

export interface TrailingProjectOperatorToken {
  /** Index in the query where the trailing in: token starts. */
  readonly start: number;
  /** The unquoted partial value typed so far (may be empty). */
  readonly partialValue: string;
}

/** Detects an in-progress trailing `in:` token — the caret is still inside
    it, so the project autocomplete should be open. Trailing whitespace (or a
    different trailing token) means the operator is committed and this
    returns null. */
export function getTrailingProjectOperatorToken(
  query: string,
): TrailingProjectOperatorToken | null {
  const match = /(^|\s)(in:("[^"]*"?|[^\s"]*))$/i.exec(query);
  if (!match) return null;
  return {
    start: match.index + match[1]!.length,
    partialValue: unquoteSearchValue(match[2]!.slice("in:".length)),
  };
}

/** Ranks project groups for the in: autocomplete: name prefix, then name
    substring, then workspace-path substring. An empty partial lists all.
    Path matching is opt-out for surfaces where a folder path coincidentally
    containing the typed words would be noise. */
export function filterProjectSuggestions<
  T extends { readonly displayName: string; readonly workspaceRoot: string },
>(
  groups: readonly T[],
  partialValue: string,
  options?: { readonly matchWorkspaceRoot?: boolean },
): T[] {
  const matchWorkspaceRoot = options?.matchWorkspaceRoot ?? true;
  const query = partialValue.trim().toLowerCase();
  if (query.length === 0) return [...groups];
  const ranked: { group: T; rank: number }[] = [];
  for (const group of groups) {
    const name = group.displayName.toLowerCase();
    const rank = name.startsWith(query)
      ? 0
      : name.includes(query)
        ? 1
        : matchWorkspaceRoot && group.workspaceRoot.toLowerCase().includes(query)
          ? 2
          : null;
    if (rank !== null) ranked.push({ group, rank });
  }
  // toSorted is stable: groups keep their input order within each rank.
  return ranked.toSorted((left, right) => left.rank - right.rank).map((entry) => entry.group);
}

/** Applies a picked project suggestion: replaces the in-progress trailing
    in: token — or, absent one, the whole query — with a quoted, committed
    filter plus a trailing space so typing continues naturally. */
export function applyProjectSuggestionToQuery(
  query: string,
  token: TrailingProjectOperatorToken | null,
  projectName: string,
): string {
  const filter = `in:"${projectName.replaceAll('"', "")}" `;
  if (token === null) return filter;
  return `${query.slice(0, token.start)}${filter}`;
}

export interface ThreadSearchQuerySegment {
  readonly text: string;
  readonly isOperator: boolean;
}

/**
 * Splits the raw query into alternating plain/operator segments covering the
 * exact input string (including whitespace), for the Discord-style operator
 * pills rendered behind the search input. A segment is highlighted only when
 * the parser would honor it: in:/agent: tokens always (an empty value means
 * the autocomplete is open), date tokens only while empty or parseable — a
 * token the parser degrades to plain text must not wear a pill.
 */
export function segmentThreadSearchQuery(query: string, now: Date): ThreadSearchQuerySegment[] {
  const operatorRanges: [number, number][] = [];
  const classifyToken = (start: number, end: number) => {
    const operator = SEARCH_OPERATOR_PATTERN.exec(query.slice(start, end));
    if (!operator) return;
    const keyword = operator[1]!.toLowerCase();
    const value = unquoteSearchValue(operator[2]!).trim();
    if (keyword === "in" || keyword === "agent") {
      operatorRanges.push([start, end]);
      return;
    }
    if (value.length === 0) {
      operatorRanges.push([start, end]);
      return;
    }
    const dateToken = resolveSearchDateToken(value, now);
    if (dateToken !== null && (keyword !== "on" || dateToken.kind === "day")) {
      operatorRanges.push([start, end]);
    }
  };

  // Same walk as tokenizeSearchQuery, but tracking positions so segments
  // reproduce the input verbatim.
  let tokenStart = -1;
  let inQuotes = false;
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index]!;
    if (char === '"') {
      inQuotes = !inQuotes;
      if (tokenStart === -1) tokenStart = index;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (tokenStart !== -1) {
        classifyToken(tokenStart, index);
        tokenStart = -1;
      }
      continue;
    }
    if (tokenStart === -1) tokenStart = index;
  }
  if (tokenStart !== -1) classifyToken(tokenStart, query.length);

  const segments: ThreadSearchQuerySegment[] = [];
  let cursor = 0;
  for (const [start, end] of operatorRanges) {
    if (start > cursor) segments.push({ text: query.slice(cursor, start), isOperator: false });
    segments.push({ text: query.slice(start, end), isOperator: true });
    cursor = end;
  }
  if (cursor < query.length) segments.push({ text: query.slice(cursor), isOperator: false });
  return segments;
}
