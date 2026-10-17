import * as Schema from "effect/Schema";
import type { IssueDependency } from "@t3tools/contracts";

export const ForgejoDependencyIssue = Schema.Struct({
  id: Schema.optional(Schema.Int),
  number: Schema.optional(Schema.Int),
  title: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        owner: Schema.String,
        name: Schema.String,
        full_name: Schema.String,
      }),
    ),
  ),
  pull_request: Schema.optional(Schema.NullOr(Schema.Struct({ merged: Schema.Boolean }))),
});

export function forgejoDependencyScope(scope: string) {
  const parts = scope.split("/");
  if (
    parts.length < 2 ||
    parts.some((part) => !/^[^\\\s%?#:]+$/.test(part) || part === "." || part === "..")
  )
    return null;
  return {
    mount: parts.slice(0, -2).join("/"),
    owner: parts.at(-2)!,
    repo: parts.at(-1)!,
    repository: parts.slice(-2).join("/"),
  };
}

export function forgejoDependency(
  issue: typeof ForgejoDependencyIssue.Type,
  baseUrl: string,
): IssueDependency | "hidden" | null {
  if (
    (issue.id === undefined || issue.id === 0) &&
    (issue.number === undefined || issue.number === 0) &&
    (issue.title === undefined || issue.title === "" || issue.title === "HIDDEN") &&
    !issue.html_url &&
    !issue.state &&
    !issue.repository &&
    !issue.pull_request
  )
    return "hidden";
  const repository = issue.repository;
  if (
    !Number.isSafeInteger(issue.number) ||
    issue.number! <= 0 ||
    !issue.title?.trim() ||
    !repository ||
    forgejoDependencyScope(`${repository.owner}/${repository.name}`)?.mount !== "" ||
    repository.full_name.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase() ||
    (issue.state !== "open" && issue.state !== "closed")
  )
    return null;
  const kind = issue.pull_request ? "pull-request" : "issue";
  const base = new URL(baseUrl);
  let url: URL;
  try {
    url = new URL(issue.html_url!);
  } catch {
    return null;
  }
  const mount = base.pathname.replace(/\/$/, "");
  const parts = url.pathname.slice(mount.length).split("/");
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.slice(0, mount.length) !== mount ||
    parts.length !== 5 ||
    parts[0] !== "" ||
    parts[1]!.toLowerCase() !== encodeURIComponent(repository.owner).toLowerCase() ||
    parts[2]!.toLowerCase() !== encodeURIComponent(repository.name).toLowerCase() ||
    parts[3] !== (kind === "pull-request" ? "pulls" : "issues") ||
    parts[4] !== String(issue.number)
  )
    return null;
  return {
    scope: `${mount ? mount.slice(1) + "/" : ""}${repository.owner}/${repository.name}`,
    key: String(issue.number),
    displayKey: `#${issue.number}`,
    title: issue.title,
    url: url.href,
    kind,
    ...(kind === "pull-request" ? { externalOnly: true } : {}),
    state:
      issue.state === "closed"
        ? { name: "closed", category: "closed", workflowCategory: "completed" }
        : { name: "open", category: "open", workflowCategory: "unstarted" },
  };
}

export function forgejoDependencyPagination(
  stderr: string,
  expected: URL,
  page: number,
  rows: number,
) {
  const counts = [...stderr.matchAll(/^x-total-count:\s*([^\r\n]*)/gim)];
  const count =
    counts.length === 1 && /^\d+$/.test(counts[0]![1]!) ? Number(counts[0]![1]) : undefined;
  if (counts.length && (count === undefined || !Number.isSafeInteger(count) || count < rows))
    return null;
  const links = [...stderr.matchAll(/^link:\s*([^\r\n]*)/gim)];
  const nativePath = (path: string) =>
    path.replace(
      /\/repos\/([^/]+)\/([^/]+)(\/issues\/[1-9]\d*\/(?:blocks|dependencies))$/,
      (_, owner: string, repo: string, suffix: string) =>
        `/repos/${owner.toLowerCase()}/${repo.toLowerCase()}${suffix}`,
    );
  const pages = new Map<string, number>();
  for (const header of links) {
    for (const part of header[1]!.split(",")) {
      const match = /^\s*<([^>]+)>\s*;\s*rel="?(next|prev|first|last)"?\s*$/.exec(part);
      if (!match) return null;
      let url: URL;
      try {
        url = new URL(match[1]!, expected);
      } catch {
        return null;
      }
      const number = Number(url.searchParams.get("page"));
      if (
        url.origin !== expected.origin ||
        nativePath(url.pathname) !== nativePath(expected.pathname) ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.size !== 2 ||
        url.searchParams.getAll("page").length !== 1 ||
        url.searchParams.get("limit") !== "50" ||
        !/^[1-9]\d{0,6}$/.test(url.searchParams.get("page") ?? "") ||
        pages.has(match[2]!) ||
        (match[2] === "next" && number !== page + 1) ||
        (match[2] === "prev" && number !== page - 1) ||
        (match[2] === "first" && number !== 1) ||
        (match[2] === "last" && number < page)
      )
        return null;
      pages.set(match[2]!, number);
    }
  }
  const last = pages.get("last");
  if (pages.has("next") && last === page) return null;
  const known = pages.has("next") || pages.has("prev") || last !== undefined;
  const more = pages.has("next") || (last !== undefined ? last > page : !known);
  const countedWhole = count === 0 || (page === 1 && count === rows);
  if (countedWhole && known && more) return null;
  return countedWhole ? { more: false, known: true } : { more, known };
}
