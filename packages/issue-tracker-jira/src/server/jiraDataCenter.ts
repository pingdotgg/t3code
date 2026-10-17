import * as Schema from "effect/Schema";

import { adfToText, isEditableAdf, jiraDate } from "./jiraJson.ts";

const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const array = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown));
const text = Schema.decodeUnknownSync(Schema.String.check(Schema.isMinLength(1)));
const count = Schema.decodeUnknownSync(
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);
const ISSUE_FIELDS_PATH = /^\/issue(?:\/[^/]+(?:\/transitions)?)?$/u;
const ISSUE_BODY_PATH = /^\/issue\/[^/]+\/(?:assignee|comment(?:\/[^/]+)?)$/u;

export function normalizeJiraInstanceHost(value: string): string {
  if (value.includes("\\")) throw new Error("Invalid Jira instance address.");
  const address = value.includes("://") ? value : "https://" + value;
  const rawPath = address.replace(/^[^:]+:\/\/[^/]+/u, "").split(/[?#]/u)[0]!;
  if (rawPath.split("/").some((part) => [".", ".."].includes(decodeURIComponent(part))))
    throw new Error("Invalid Jira instance base path.");
  const url = new URL(address);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Use an HTTPS Jira instance address.");
  const path = url.pathname.replace(/\/$/u, "");
  if (
    path
      .split("/")
      .slice(1)
      .some((segment) => {
        const decoded = decodeURIComponent(segment);
        return !decoded || decoded === "." || decoded === ".." || /[/\\]/u.test(decoded);
      })
  )
    throw new Error("Invalid Jira instance base path.");
  return url.host.toLowerCase() + path;
}

export function jiraIssueUrl(host: string, key: string): string {
  return "https://" + normalizeJiraInstanceHost(host) + "/browse/" + encodeURIComponent(key);
}

function dataCenterUser(value: unknown) {
  const user = record(value);
  return { ...user, accountId: text(user.key ?? user.name) };
}

function actorFields(value: unknown) {
  const fields = record(value);
  return {
    ...fields,
    ...Object.fromEntries(
      ["author", "updateAuthor", "creator", "reporter", "assignee"]
        .filter((key) => fields[key] !== undefined && fields[key] !== null)
        .map((key) => [key, dataCenterUser(fields[key])]),
    ),
  };
}

function chronological(values: ReadonlyArray<unknown>) {
  return values
    .map((value) => {
      const entry = record(value);
      return { entry, created: Date.parse(jiraDate(text(entry.created))), id: text(entry.id) };
    })
    .toSorted(
      (left, right) =>
        left.created - right.created || left.id.localeCompare(right.id, "en", { numeric: true }),
    )
    .map(({ entry }) => entry);
}

function issue(value: unknown) {
  const raw = record(value);
  const fields = actorFields(raw.fields);
  if (fields.comment !== undefined && fields.comment !== null) {
    const page = record(fields.comment);
    const { comments, ...metadata } = page;
    const embedded = comments === undefined ? undefined : array(comments);
    fields.comment = {
      ...metadata,
      ...(embedded !== undefined &&
      count(page.startAt ?? 0) === 0 &&
      embedded.length === count(page.total)
        ? {
            startAt: 0,
            maxResults: Math.min(50, embedded.length),
            comments: chronological(embedded).slice(-50).map(actorFields),
          }
        : {}),
    };
  }
  const history = raw.changelog === undefined ? undefined : record(raw.changelog);
  const histories = history === undefined ? [] : array(history.histories);
  return {
    ...raw,
    fields,
    ...(history === undefined
      ? {}
      : {
          changelog: {
            ...history,
            total: count(history.total ?? histories.length),
            startAt:
              count(history.startAt ?? 0) === 0 &&
              histories.length === count(history.total ?? histories.length)
                ? Math.max(0, histories.length - 100)
                : count(history.startAt ?? 0),
            histories: (count(history.startAt ?? 0) === 0 &&
            histories.length === count(history.total ?? histories.length)
              ? chronological(histories).slice(-100)
              : histories.slice(0, 100)
            ).map(actorFields),
          },
        }),
  };
}

function offset(value: unknown) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value))
    throw new Error("Invalid Jira Data Center cursor.");
  return count(Number(value));
}

function pageLimit(value: unknown) {
  const limit = count(value ?? 100);
  if (limit < 1 || limit > 200) throw new Error("Invalid Jira Data Center page size.");
  return limit;
}

function wikiBody(value: unknown): unknown {
  if (value === null || typeof value === "string") return value;
  if (!isEditableAdf(value))
    throw new Error("Rich ADF cannot be written to a Jira Data Center wiki field.");
  return adfToText(value);
}

export function dataCenterAssignee(path: string, value: unknown): string | null {
  if (value === undefined) return null;
  const pathname = new URL("https://jira.invalid" + path).pathname;
  if (!ISSUE_FIELDS_PATH.test(pathname) && !/^\/issue\/[^/]+\/assignee$/u.test(pathname))
    return null;
  const body = record(value);
  const assignee = pathname.endsWith("/assignee")
    ? body
    : body.fields === undefined
      ? null
      : record(body.fields).assignee;
  if (assignee === null || assignee === undefined) return null;
  const selected = record(assignee);
  return selected.accountId === null || selected.accountId === undefined
    ? null
    : text(selected.accountId);
}

export function dataCenterRequest(input: {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
  readonly assigneeName?: string;
}) {
  const url = new URL("https://jira.invalid" + input.path);
  const agile =
    (input.method === "GET" &&
      /^\/agile\/1\.0\/(?:issue\/[^/]+|epic\/[^/]+(?:\/issue)?)$/u.test(url.pathname)) ||
    (input.method === "POST" && /^\/agile\/1\.0\/epic\/[^/]+\/issue$/u.test(url.pathname));
  if (url.pathname.startsWith("/agile/") && !agile)
    throw new Error("Unsupported Jira Data Center Agile operation.");
  let path = input.path;
  let body = input.body;
  if (url.pathname === "/project/search") path = "/project";
  else if (url.pathname === "/search/jql") {
    const original = record(body);
    const { nextPageToken, ...fields } = original;
    body = { ...fields, startAt: offset(nextPageToken) };
    pageLimit(fields.maxResults);
    path = "/search";
  } else if (url.pathname === "/user/assignable/search") {
    if (offset(url.searchParams.get("startAt")) !== 0)
      throw new Error("Jira Data Center assignable users cannot be paginated.");
    url.searchParams.delete("startAt");
    url.searchParams.set(
      "maxResults",
      String(Math.min(100, pageLimit(Number(url.searchParams.get("maxResults") ?? 100)))),
    );
    path = url.pathname + url.search;
  } else if (/^\/issue\/[^/]+\/changelog$/u.test(url.pathname)) {
    offset(url.searchParams.get("startAt"));
    pageLimit(Number(url.searchParams.get("maxResults") ?? 100));
    path = url.pathname.replace(/\/changelog$/u, "") + "?fields=project&expand=changelog";
  }
  if (
    input.method !== "GET" &&
    body !== undefined &&
    (ISSUE_FIELDS_PATH.test(url.pathname) || ISSUE_BODY_PATH.test(url.pathname))
  ) {
    const original = record(body);
    const fields =
      ISSUE_FIELDS_PATH.test(url.pathname) && original.fields !== undefined
        ? record(original.fields)
        : undefined;
    body = {
      ...original,
      ...(original.body === undefined ? {} : { body: wikiBody(original.body) }),
      ...(fields === undefined
        ? {}
        : {
            fields: {
              ...fields,
              ...(fields.description === undefined
                ? {}
                : { description: wikiBody(fields.description) }),
              ...(input.assigneeName === undefined
                ? {}
                : { assignee: { name: input.assigneeName } }),
            },
          }),
    };
    if (url.pathname.endsWith("/assignee")) {
      if (original.accountId === null) body = { name: null };
      else if (input.assigneeName !== undefined) body = { name: input.assigneeName };
    }
  }
  return { path, body, apiBase: agile ? "/rest" : "/rest/api/2" };
}

export function dataCenterResponse(path: string, body: unknown, response: unknown): unknown {
  const url = new URL("https://jira.invalid" + path);
  if (url.pathname === "/myself" || url.pathname === "/user") return dataCenterUser(response);
  if (url.pathname === "/user/assignable/search") return array(response).map(dataCenterUser);
  if (url.pathname === "/project/search") {
    const projects = array(response);
    const startAt = offset(url.searchParams.get("startAt"));
    const limit = pageLimit(Number(url.searchParams.get("maxResults") ?? 100));
    return { startAt, total: projects.length, values: projects.slice(startAt, startAt + limit) };
  }
  if (url.pathname === "/search/jql") {
    const request = record(body);
    const page = record(response);
    const startAt = offset(request.nextPageToken);
    const total = count(page.total);
    const issues = array(page.issues);
    const next = startAt + issues.length;
    if (
      count(page.startAt) !== startAt ||
      issues.length > pageLimit(request.maxResults) ||
      next > total ||
      (!issues.length && next < total)
    )
      throw new Error("Inconsistent Jira Data Center search page.");
    return {
      ...page,
      issues: issues.map(issue),
      isLast: next >= total,
      ...(next < total ? { nextPageToken: String(next) } : {}),
    };
  }
  if (/^\/agile\/1\.0\/epic\/[^/]+\/issue$/u.test(url.pathname)) {
    const startAt = offset(url.searchParams.get("startAt"));
    const limit = pageLimit(Number(url.searchParams.get("maxResults") ?? 100));
    return dataCenterResponse(
      "/search/jql",
      { nextPageToken: String(startAt), maxResults: limit },
      response,
    );
  }
  if (/^\/agile\/1\.0\/issue\/[^/]+$/u.test(url.pathname)) return issue(response);
  if (/^\/issue\/createmeta\/[^/]+\/issuetypes(?:\/[^/]+)?$/u.test(url.pathname)) {
    const page = record(response);
    const values = array(page.values);
    const startAt = count(page.start ?? page.startAt);
    const isLast = page.last ?? page.isLast;
    if (startAt !== offset(url.searchParams.get("startAt")))
      throw new Error("Inconsistent Jira Data Center metadata page.");
    return {
      ...page,
      startAt,
      ...(isLast === undefined ? {} : { isLast }),
      ...(page.size === undefined ? {} : { maxResults: count(page.size) }),
      ...(page.total === undefined && isLast === true ? { total: startAt + values.length } : {}),
      [url.pathname.split("/").length === 5 ? "issueTypes" : "fields"]: values,
    };
  }
  if (/^\/issue\/[^/]+\/changelog$/u.test(url.pathname)) {
    const page = record(record(response).changelog);
    const startAt = offset(url.searchParams.get("startAt"));
    const limit = pageLimit(Number(url.searchParams.get("maxResults") ?? 100));
    const nativeStart = count(page.startAt ?? 0);
    const histories = array(page.histories);
    const total = count(page.total);
    if (nativeStart !== 0 || histories.length !== total || startAt > total)
      throw new Error("Jira Data Center did not return a complete changelog.");
    return {
      startAt,
      total,
      values: chronological(histories)
        .slice(startAt, startAt + limit)
        .map(actorFields),
      isLast: startAt + limit >= total,
    };
  }
  if (/^\/issue\/[^/]+\/comment$/u.test(url.pathname)) {
    const page = record(response);
    return Array.isArray(page.comments)
      ? { ...page, comments: page.comments.map(actorFields) }
      : actorFields(page);
  }
  if (/^\/issue\/[^/]+\/comment\/[^/]+$/u.test(url.pathname)) return actorFields(response);
  if (/^\/issue\/[^/]+$/u.test(url.pathname) && record(response).fields !== undefined)
    return issue(response);
  return response;
}
