import {
  TaskIntegrationError,
  type ExternalTask,
  type TaskField,
  type TaskRequest,
  type TaskSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type TaskTransport = (
  path: string,
  body?: unknown,
  method?: string,
) => Effect.Effect<unknown, TaskIntegrationError>;
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((current, key) => object(current)[key], value);
const nodes = (value: unknown) => array(at(value, "nodes"));
const invalid = (message: string) => new TaskIntegrationError({ code: "invalid", message });
const emptyTask = { assignee: "", labels: [], priority: "", comments: [], relationships: [] };

/** Advertise only fields implemented by the selected provider adapter. */
export function taskEditableFields(provider: TaskSource["provider"]): TaskField[] {
  return provider === "github"
    ? ["title", "description", "status", "assignee", "labels"]
    : ["title", "description", "status", "assignee", "labels", "priority"];
}

/** Only a configured origin and scope may resolve pasted links. URLs never become request targets. */
export function resolveTaskReference(source: TaskSource, reference: string): string {
  if (!reference.includes("://")) {
    if (/^[\w-]+$/.test(reference)) return reference;
    throw invalid("Enter an issue number, key, or a supported issue URL.");
  }
  const url = new URL(reference);
  const configured = new URL(source.baseUrl);
  if (url.origin !== configured.origin || url.username || url.password)
    throw invalid("The issue URL does not belong to this task source.");
  const scope = source.scope.replace(/^\/+|\/+$/g, "");
  let id: string | undefined;
  if (source.provider === "github" && url.pathname.startsWith(`/${scope}/issues/`))
    id = url.pathname.split("/")[4];
  if (source.provider === "linear")
    id = url.pathname.match(/\/issue\/([A-Za-z0-9]+-\d+)(?:\/|$)/)?.[1];
  if (!id || !/^[\w-]+$/.test(id))
    throw invalid("This is not a supported issue URL for the selected project.");
  return id;
}

/** Translate a GitHub issue into task data while keeping issue text as untrusted content. */
function githubTask(value: unknown): ExternalTask {
  const v = object(value);
  return {
    ...emptyTask,
    id: string(v.number),
    key: `#${string(v.number)}`,
    url: string(v.html_url),
    title: string(v.title),
    description: string(v.body),
    status: string(v.state),
    assignee: array(v.assignees)
      .map((a) => string(at(a, "login")))
      .join(", "),
    labels: array(v.labels).map((label) =>
      typeof label === "string" ? label : string(at(label, "name")),
    ),
  };
}
const LINEAR_FIELDS =
  "id identifier title description url branchName priority state { id name } assignee { id name } labels { nodes { id name } }";
/** Translate Linear fields, comments, relationships, and suggested branch names into task data. */
function linearTask(value: unknown): ExternalTask {
  const v = object(value);
  return {
    ...emptyTask,
    id: string(v.id),
    key: string(v.identifier),
    title: string(v.title),
    description: string(v.description),
    url: string(v.url),
    branchName: string(v.branchName),
    status: string(at(v.state, "name")),
    assignee: string(at(v.assignee, "name")),
    priority: string(v.priority),
    labels: nodes(v.labels).map((label) => string(at(label, "name"))),
    comments: nodes(v.comments).map((c) => ({
      id: string(at(c, "id")),
      author: string(at(c, "user", "name")),
      body: string(at(c, "body")),
    })),
    relationships: nodes(v.relations)
      .map((r) => ({
        title: `${string(at(r, "type"))}: ${string(at(r, "relatedIssue", "identifier"))}`,
        url: string(at(r, "relatedIssue", "url")),
      }))
      .filter((r) => r.url.startsWith("https://linear.app/")),
  };
}
export const runTaskProvider = Effect.fn("runTaskProvider")(function* (
  source: TaskSource,
  input: TaskRequest,
  request: TaskTransport,
) {
  let tasks: ExternalTask[] = [],
    nextCursor: string | null = null;
  let fieldOptions: Record<string, { value: string; label: string }[]> | undefined;
  const fields = taskEditableFields(source.provider);
  const detail = input.action === "detail";
  const write = input.action === "update" || input.action === "comment";
  const id =
    detail || write
      ? yield* Effect.try({
          try: () => resolveTaskReference(source, input.id ?? ""),
          catch: () => invalid("Invalid issue reference for this source."),
        })
      : "";
  const changes = input.changes ?? {};
  for (const key of Object.keys(changes))
    if (!fields.includes(key as TaskField))
      return yield* invalid("This field is not editable for this provider.");
  const page = Math.max(1, Math.min(1000, Number(input.cursor ?? "1") || 1));
  const limit = 30;
  if (source.provider === "github") {
    const repo = source.scope.split("/").map(encodeURIComponent).join("/");
    const endpoint = `repos/${repo}/issues`;
    if (input.action === "projects" || input.action === "items") {
      const owner = source.scope.split("/")[0]!;
      const result = yield* request(
        "graphql",
        input.action === "projects"
          ? {
              query:
                "query($owner:String!,$after:String){repositoryOwner(login:$owner){... on User{projectsV2(first:30,after:$after){nodes{id number title url shortDescription}pageInfo{hasNextPage endCursor}}}... on Organization{projectsV2(first:30,after:$after){nodes{id number title url shortDescription}pageInfo{hasNextPage endCursor}}}}}",
              variables: { owner, after: input.cursor ?? null },
            }
          : {
              query:
                "query($id:ID!,$after:String){node(id:$id){... on ProjectV2{url items(first:30,after:$after){nodes{id content{... on Issue{number title body url state repository{nameWithOwner}}... on DraftIssue{title body}}}pageInfo{hasNextPage endCursor}}}}}",
              variables: { id: input.id, after: input.cursor ?? null },
            },
      );
      if (array(at(result, "errors")).length)
        return yield* invalid(
          "GitHub Projects could not be read. Check project access and the read:project token scope.",
        );
      const connection =
        input.action === "projects"
          ? at(result, "data", "repositoryOwner", "projectsV2")
          : at(result, "data", "node", "items");
      tasks = nodes(connection)
        .filter(
          (value) =>
            input.action === "projects" || string(at(value, "content", "title")).trim() !== "",
        )
        .map((value) => {
          const item = object(value),
            content = object(item.content);
          return input.action === "projects"
            ? {
                ...emptyTask,
                id: string(item.id),
                key: `Project ${string(item.number)}`,
                title: string(item.title),
                description: string(item.shortDescription),
                url: string(item.url),
                status: "",
              }
            : {
                ...emptyTask,
                id: string(content.number) || string(item.id),
                key: string(content.number) ? `#${string(content.number)}` : "Draft item",
                title: string(content.title),
                description: string(content.body),
                url:
                  string(content.url) ||
                  `${string(at(result, "data", "node", "url"))}?pane=issue&itemId=${encodeURIComponent(string(item.id))}`,
                status: string(content.state),
              };
        });
      if (at(connection, "pageInfo", "hasNextPage"))
        nextCursor = string(at(connection, "pageInfo", "endCursor"));
    } else if (input.action === "list") {
      const q = `repo:${source.scope} is:issue ${input.filter === "closed" ? "is:closed" : input.filter === "all" ? "" : "is:open"} ${input.query?.trim() ? `"${input.query.replace(/["\\]/g, " ")}"` : ""}`;
      const result = yield* request(
        `search/issues?q=${encodeURIComponent(q)}&per_page=${limit}&page=${page}`,
      );
      tasks = array(at(result, "items")).map(githubTask);
      if (!Array.isArray(at(result, "items")))
        return yield* invalid("GitHub returned an invalid issue list.");
      if (page * limit < Math.min(1000, Number(at(result, "total_count"))))
        nextCursor = String(page + 1);
    } else if (detail) {
      const result = yield* request(`${endpoint}/${id}`);
      if (at(result, "pull_request"))
        return yield* invalid("This URL is a pull request. Open Pull Requests to review it.");
      const comments = yield* request(`${endpoint}/${id}/comments?per_page=100`);
      tasks = [
        {
          ...githubTask(result),
          comments: array(comments).map((c) => ({
            id: string(at(c, "id")),
            author: string(at(c, "user", "login")),
            body: string(at(c, "body")),
          })),
        },
      ];
    } else if (input.action === "create") {
      const created = yield* request(
        endpoint,
        { title: changes.title, body: changes.description ?? "" },
        "POST",
      );
      tasks = [githubTask(created)];
    } else if (input.action === "comment") {
      yield* request(`${endpoint}/${id}/comments`, { body: input.comment }, "POST");
    } else if (input.action === "update") {
      const body: Json = {};
      for (const [key, value] of Object.entries(changes)) {
        body[
          key === "description"
            ? "body"
            : key === "status"
              ? "state"
              : key === "assignee"
                ? "assignees"
                : key
        ] =
          key === "assignee" || key === "labels"
            ? value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : value;
      }
      yield* request(`${endpoint}/${id}`, body, "PATCH");
    }
  } else if (source.provider === "linear") {
    const gql = (query: string, variables: Json) =>
      request("graphql", { query, variables }).pipe(
        Effect.flatMap((result) =>
          array(at(result, "errors")).length
            ? Effect.fail(
                invalid(
                  "Linear rejected the request. Check field IDs, permissions, and team scope.",
                ),
              )
            : Effect.succeed(object(at(result, "data"))),
        ),
      );
    if (write) {
      const scope = yield* gql("query($id:String!){issue(id:$id){team{id}}}", { id });
      if (string(at(scope, "issue", "team", "id")) !== source.scope)
        return yield* invalid("This issue is outside the selected Linear team.");
    }
    if (input.action === "list") {
      const filter: Json = { team: { id: { eq: source.scope } } };
      if (input.query) filter.title = { containsIgnoreCase: input.query };
      if (input.filter !== "all")
        filter.state = {
          type:
            input.filter === "closed"
              ? { in: ["completed", "canceled"] }
              : { nin: ["completed", "canceled"] },
        };
      const result = yield* gql(
        `query($filter:IssueFilter,$after:String){issues(first:30,after:$after,filter:$filter){nodes{${LINEAR_FIELDS}}pageInfo{hasNextPage endCursor}}}`,
        { filter, after: input.cursor ?? null },
      );
      if (!Array.isArray(at(result, "issues", "nodes")))
        return yield* invalid("Linear returned an invalid issue list.");
      tasks = nodes(result.issues).map(linearTask);
      if (at(result.issues, "pageInfo", "hasNextPage"))
        nextCursor = string(at(result.issues, "pageInfo", "endCursor"));
    } else if (detail) {
      const result = yield* gql(
        `query($id:String!){issue(id:$id){${LINEAR_FIELDS} team{id states{nodes{id name}} members(first:100){nodes{id name}} labels(first:100){nodes{id name}}} comments(first:100){nodes{id body user{name}}} relations{nodes{type relatedIssue{identifier url}}}}}`,
        { id },
      );
      if (string(at(result, "issue", "team", "id")) !== source.scope)
        return yield* invalid("This issue is outside the selected Linear team.");
      tasks = [linearTask(result.issue)];
      /** Convert the selected issue's team metadata into choices for editable Linear fields. */
      const options = (name: string) =>
        nodes(at(result, "issue", "team", name)).map((value) => ({
          value: string(at(value, "id")),
          label: string(at(value, "name")),
        }));
      fieldOptions = {
        status: options("states"),
        assignee: [{ value: "", label: "Unassigned" }, ...options("members")],
        labels: options("labels"),
        priority: ["No priority", "Urgent", "High", "Normal", "Low"].map((label, value) => ({
          value: String(value),
          label,
        })),
      };
    } else if (input.action === "create") {
      const created = yield* gql(
        `mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{${LINEAR_FIELDS}}}}`,
        {
          input: {
            teamId: source.scope,
            title: changes.title,
            description: changes.description ?? "",
          },
        },
      );
      if (at(created, "issueCreate", "success") !== true)
        return yield* invalid("Linear did not confirm issue creation.");
      tasks = [linearTask(at(created, "issueCreate", "issue"))];
    } else if (input.action === "comment") {
      const result = yield* gql(
        "mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}",
        { input: { issueId: id, body: input.comment } },
      );
      if (at(result, "commentCreate", "success") !== true)
        return yield* invalid("Linear did not confirm the comment.");
    } else if (input.action === "update") {
      const update: Json = {};
      for (const [key, value] of Object.entries(changes))
        update[
          key === "status"
            ? "stateId"
            : key === "assignee"
              ? "assigneeId"
              : key === "labels"
                ? "labelIds"
                : key
        ] =
          key === "priority"
            ? Number(value)
            : key === "labels"
              ? value.split(",").filter(Boolean)
              : value || null;
      const result = yield* gql(
        "mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}",
        { id, input: update },
      );
      if (at(result, "issueUpdate", "success") !== true)
        return yield* invalid("Linear did not confirm the update.");
    }
  }
  if (tasks.some((task) => !task.id || !task.title || !task.url.startsWith(`${source.baseUrl}/`)))
    return yield* invalid("The task source returned an incomplete response.");
  return { tasks, nextCursor, ...(fieldOptions ? { fieldOptions } : {}) };
});
