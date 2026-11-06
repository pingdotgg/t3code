import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { jiraProperties, jiraRelatedIssues, jiraWebLinks } from "./jiraProperties.ts";
import { IssueTrackerKind, type IssueCapabilities } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";
import { SourceControlHost } from "@t3tools/source-control-core/server/SourceControlHost";
import {
  JiraIssueFields,
  JIRA_LIST_FIELDS,
  decodeJiraCommentsPage,
  decodeJiraProjects,
  decodeJiraViewer,
  renderJiraBody,
  toJiraSummary,
} from "./jiraJson.ts";

export const KIND = IssueTrackerKind.make("jira");
const capabilities: IssueCapabilities = {
  create: false,
  edit: false,
  comment: true,
  internalComments: true,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
  states: [],
  closeReasons: [],
};
const permissions = {
  setState: false,
  comment: true,
  edit: false,
  labels: false,
  assignees: false,
};

const NativeIssue = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  ...JiraIssueFields.fields,
});
const Search = Schema.Struct({
  data: Schema.Struct({ issues: Schema.Array(NativeIssue) }),
  pageInfo: Schema.optional(
    Schema.Struct({
      hasNextPage: Schema.Boolean,
      nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const Get = Schema.Struct({ data: Schema.Array(NativeIssue) });
const RawGet = Schema.Struct({ data: Schema.Array(Schema.JsonObject) });
const FieldNames = Schema.Struct({
  data: Schema.Struct({
    fields: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  }),
});
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const fail = (operation: string, reason: IssueTrackerError["reason"] = "failed") =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail:
      reason === "unauthenticated"
        ? "Run `twg login` on this environment."
        : reason === "missing-tool"
          ? "Install the Atlassian TWG CLI on this environment."
          : "The TWG Jira request failed.",
  });

export function parseScope(value: string) {
  const match = /^([a-z0-9-]+\.atlassian\.net)\/([A-Z][A-Z0-9_]*)$/i.exec(value);
  return match ? { host: match[1]!.toLowerCase(), scope: match[2]!.toUpperCase() } : null;
}

export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost;
  const run = Effect.fn("JiraIssueTracker.run")(function* (
    operation: string,
    site: string | undefined,
    args: ReadonlyArray<string>,
    cwd = ".",
  ) {
    const result = yield* host.process
      .run({
        operation,
        command: "twg",
        cwd,
        args: [
          ...(site ? ["--site", site] : []),
          "--output",
          "json",
          "--output-summary",
          "none",
          "--timeout-ms",
          "20000",
          ...args,
        ],
        allowNonZeroExit: true,
        timeoutMs: 30000,
        maxOutputBytes: 4 * 1024 * 1024,
        outputMode: "error",
      })
      .pipe(
        Effect.mapError((error) =>
          fail(operation, error._tag === "VcsProcessSpawnError" ? "missing-tool" : "failed"),
        ),
      );
    if (result.exitCode !== 0 || result.stdoutTruncated || result.stdoutInvalidUtf8) {
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      return yield* fail(
        operation,
        /401|AUTH_REQUIRED|unauthenticated|not (?:logged|signed) in/i.test(diagnostic)
          ? "unauthenticated"
          : /429|rate.?limit/i.test(diagnostic)
            ? "rate-limited"
            : "failed",
      );
    }
    return result.stdout;
  });
  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    operation: string,
    text: string,
  ) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(() => fail(operation)),
    );
  const checkTarget = (input: { readonly scope: string; readonly key: string }) =>
    /^[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(input.key) &&
    input.key.slice(0, input.key.lastIndexOf("-")) === input.scope
      ? Effect.void
      : Effect.fail(fail("issueTarget"));
  const comments = Effect.fn("JiraIssueTracker.comments")(function* (
    input: {
      readonly host: string;
      readonly key: string;
      readonly cwd: string;
      readonly scope: string;
    },
    cursor?: string,
  ) {
    yield* checkTarget(input);
    const text = yield* run(
      "comments",
      input.host,
      [
        "jira",
        "workitem",
        "comment",
        "query",
        "--issue-id",
        input.key,
        "--first",
        "50",
        "--order-by=created",
        ...(cursor ? ["--after", cursor] : []),
      ],
      input.cwd,
    );
    return yield* decodeJiraCommentsPage(text, `https://${input.host}/browse/${input.key}`).pipe(
      Effect.mapError(() => fail("comments")),
    );
  });
  return {
    kind: KIND,
    capabilities,
    standalone: {
      tracker: KIND,
      displayName: "Jira",
      host: "atlassian.net",
      scopeNoun: "project",
      credential: { label: "TWG login", helpUrl: null },
      environmentLogin:
        "Uses the TWG CLI login on this environment. Run `twg login` there, then refresh.",
    },
    resolveScope: parseScope,
    probeCredential: Effect.fn("JiraIssueTracker.probeCredential")(function* () {
      const viewer = yield* run("status", undefined, ["whoami"]).pipe(
        Effect.flatMap(decodeJiraViewer),
        Effect.mapError(() => fail("status", "unauthenticated")),
      );
      const scopes: Array<{ key: string; name: string }> = [];
      let startAt = 0;
      while (true) {
        const projects = yield* run("status", undefined, [
          "jira",
          "space",
          "query",
          "--limit",
          "100",
          "--start-at",
          String(startAt),
        ]).pipe(
          Effect.flatMap(decodeJiraProjects),
          Effect.mapError(() => fail("status")),
        );
        scopes.push(
          ...projects.projects.map((p) => ({ key: `${projects.site}/${p.key}`, name: p.name })),
        );
        if (projects.nextStart === null) break;
        if (projects.nextStart <= startAt) return yield* fail("status");
        startAt = projects.nextStart;
      }
      return { account: viewer, scopes };
    }),
    getViewer: (input) =>
      run("getViewer", input.host, ["whoami"], input.cwd).pipe(
        Effect.flatMap(decodeJiraViewer),
        Effect.mapError(() => fail("getViewer")),
      ),
    listIssues: Effect.fn("JiraIssueTracker.listIssues")(function* (
      input: Parameters<StandaloneIssueTrackerApi["listIssues"]>[0],
    ) {
      const clauses = [`project = ${quote(input.scope)}`];
      if (input.state !== "all")
        clauses.push(`statusCategory ${input.state === "open" ? "!=" : "="} Done`);
      if (input.involvement === "assigned") clauses.push("assignee = currentUser()");
      if (input.involvement === "authored") clauses.push("reporter = currentUser()");
      if (input.involvement === "mentioned")
        return yield* new IssueTrackerError({
          tracker: KIND,
          operation: "listIssues",
          reason: "failed",
          detail: "Jira does not support searching issue mentions.",
        });
      if (input.query?.trim()) clauses.push(`text ~ ${quote(input.query.trim())}`);
      const text = yield* run(
        "listIssues",
        input.host,
        [
          "jira",
          "workitem",
          "query",
          "--jql",
          `${clauses.join(" AND ")} ORDER BY updated DESC`,
          "--fields",
          JIRA_LIST_FIELDS,
          "--limit",
          String(input.limit),
          ...(input.cursor ? ["--after", input.cursor] : []),
        ],
        input.cwd,
      );
      const page = yield* decode(Search, "listIssues", text);
      return {
        items: page.data.issues.map((issue) =>
          toJiraSummary({ id: issue.id, key: issue.key, fields: issue }, input.host),
        ),
        nextCursor: page.pageInfo?.hasNextPage ? (page.pageInfo.nextCursor ?? null) : null,
      };
    }),
    getIssue: Effect.fn("JiraIssueTracker.getIssue")(function* (
      input: Parameters<StandaloneIssueTrackerApi["getIssue"]>[0],
    ) {
      yield* checkTarget(input);
      const text = yield* run(
        "getIssue",
        input.host,
        ["jira", "workitem", "get", input.key, "--fields", "*all", "--remote-links"],
        input.cwd,
      );
      const data = yield* decode(Get, "getIssue", text);
      const raw = (yield* decode(RawGet, "getIssue", text)).data[0]!;
      const names = yield* run(
        "fieldNames",
        input.host,
        [
          "jira",
          "workitem",
          "field",
          "update-metadata",
          "--id",
          input.key,
          "--include-system-fields",
        ],
        input.cwd,
      ).pipe(
        Effect.flatMap((text) => decode(FieldNames, "fieldNames", text)),
        Effect.map(
          (metadata) => new Map(metadata.data.fields.map((field) => [field.id, field.name])),
        ),
        Effect.orElseSucceed(() => new Map<string, string>()),
      );
      const issue = data.data[0];
      if (!issue || issue.key !== input.key) return yield* fail("getIssue", "not-found");
      const body = yield* renderJiraBody("getIssue", issue.description).pipe(
        Effect.mapError(() => fail("getIssue")),
      );
      const page = yield* comments(input);
      return {
        ...toJiraSummary({ id: issue.id, key: issue.key, fields: issue }, input.host),
        commentCount: Math.max(issue.comment?.total ?? 0, page.total),
        body,
        nativeId: issue.id,
        properties: jiraProperties(raw, names),
        relatedIssues: jiraRelatedIssues(raw, input.host),
        webLinks: jiraWebLinks(raw),
        viewer: null,
        viewerPermissions: permissions,
        comments: page.comments,
        commentsCursor: page.nextCursor,
        events: [],
        linkedPullRequests: [],
      };
    }),
    getComments: (input) =>
      comments(input, input.cursor).pipe(
        Effect.map((page) => ({ comments: page.comments, nextCursor: page.nextCursor })),
      ),
    comment: Effect.fn("JiraIssueTracker.comment")(function* (
      input: Parameters<NonNullable<StandaloneIssueTrackerApi["comment"]>>[0],
    ) {
      yield* checkTarget(input);
      yield* run(
        "comment",
        input.host,
        [
          "jira",
          "workitem",
          "comment",
          "create",
          "--issue-id",
          input.key,
          "--body",
          input.body,
          "--body-format",
          "markdown",
          ...(input.visibility === "internal" ? ["--internal"] : []),
        ],
        input.cwd,
      );
    }),
  } satisfies StandaloneIssueTrackerApi;
});
