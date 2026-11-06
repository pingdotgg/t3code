import * as Schema from "effect/Schema";
import type { IssueProperty, IssueRelatedIssue } from "@t3tools/contracts";

const LinkedIssue = Schema.Struct({
  key: Schema.String,
  fields: Schema.optional(
    Schema.Struct({
      summary: Schema.optional(Schema.String),
      status: Schema.optional(
        Schema.Struct({
          name: Schema.String,
          statusCategory: Schema.optional(Schema.Struct({ key: Schema.String })),
        }),
      ),
    }),
  ),
});
const isLinkedIssue = Schema.is(LinkedIssue);
const Link = Schema.Struct({
  type: Schema.Struct({
    name: Schema.String,
    inward: Schema.optional(Schema.String),
    outward: Schema.optional(Schema.String),
  }),
  inwardIssue: Schema.optional(LinkedIssue),
  outwardIssue: Schema.optional(LinkedIssue),
});
const isLink = Schema.is(Link);
const WebLink = Schema.Struct({
  object: Schema.Struct({ title: Schema.String, url: Schema.String }),
});
const isWebLink = Schema.is(WebLink);
const OMIT = new Set([
  "id",
  "key",
  "self",
  "expand",
  "url",
  "description",
  "comment",
  "issuelinks",
  "remoteLinks",
  "parent",
  "subtasks",
]);
const LABELS: Record<string, string> = {
  summary: "Summary",
  status: "Status",
  assignee: "Assignee",
  reporter: "Reporter",
  priority: "Priority",
  issuetype: "Issue type",
  labels: "Labels",
  fixVersions: "Fix versions",
  created: "Created",
  updated: "Updated",
  duedate: "Due date",
  resolution: "Resolution",
  resolutiondate: "Resolved",
};

export function jiraProperties(
  raw: Schema.JsonObject,
  names: ReadonlyMap<string, string>,
): ReadonlyArray<IssueProperty> {
  return Object.entries(raw)
    .filter(([id]) => !OMIT.has(id))
    .slice(0, 2000)
    .map(([id, value]) => ({ id, label: names.get(id) ?? LABELS[id] ?? id, value }));
}

export function jiraRelatedIssues(
  raw: Schema.JsonObject,
  host: string,
): ReadonlyArray<IssueRelatedIssue> {
  const result: IssueRelatedIssue[] = [];
  const add = (issue: typeof LinkedIssue.Type, relation: string) => {
    const match = /^([A-Z][A-Z0-9_]*)-[1-9]\d*$/.exec(issue.key);
    if (!match) return;
    const status = issue.fields?.status;
    result.push({
      key: issue.key,
      scope: match[1]!,
      title: issue.fields?.summary ?? issue.key,
      url: `https://${host}/browse/${issue.key}`,
      relation,
      ...(status
        ? {
            state: {
              category:
                status.statusCategory?.key === "done" ? ("closed" as const) : ("open" as const),
              name: status.name,
            },
          }
        : {}),
    });
  };
  if (isLinkedIssue(raw.parent)) add(raw.parent, "Parent");
  if (Array.isArray(raw.subtasks))
    for (const issue of raw.subtasks) if (isLinkedIssue(issue)) add(issue, "Sub-issue");
  if (Array.isArray(raw.issuelinks))
    for (const link of raw.issuelinks) {
      if (!isLink(link)) continue;
      if (link.outwardIssue) add(link.outwardIssue, link.type.outward ?? link.type.name);
      if (link.inwardIssue) add(link.inwardIssue, link.type.inward ?? link.type.name);
    }
  return result.slice(0, 2000);
}

export function jiraWebLinks(raw: Schema.JsonObject) {
  return (Array.isArray(raw.remoteLinks) ? raw.remoteLinks : [])
    .flatMap((link) =>
      isWebLink(link) && /^https?:\/\//i.test(link.object.url)
        ? [{ title: link.object.title || link.object.url, url: link.object.url }]
        : [],
    )
    .slice(0, 2000);
}
