import {
  VaultConnectionSecretText,
  VaultServiceRead,
  VaultTokenService,
  type VaultServiceItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export interface ServiceConnection {
  readonly service: VaultTokenService;
  readonly account: string;
  readonly token: string;
  readonly revision: string;
}

const messages = {
  operation: "This operation is not available for that credential.",
  authorization: "The service rejected this credential. Check the token and its permissions.",
  response: "The service did not return a valid response.",
  unavailable: "Could not reach the service. Try again later.",
  timeout: "The service did not respond in time.",
} as const;
class ConnectionError extends Schema.TaggedError<ConnectionError>()("VaultConnectionError", {
  code: Schema.Literals(["operation", "authorization", "response", "unavailable", "timeout"]),
}) {
  override get message() {
    return messages[this.code];
  }
}
const error = (code: keyof typeof messages) => new ConnectionError({ code });
const validToken = Schema.is(VaultConnectionSecretText);
const isVaultTokenService = Schema.is(VaultTokenService);
const isVaultServiceRead = Schema.is(VaultServiceRead);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

// No caller-supplied URL, redirect, cookie, upstream response body or raw transport error
// may cross this boundary. Limit the decoded stream, not merely its claimed Content-Length.
const requestJson = Effect.fnUntraced(
  function* (request: HttpClientRequest.HttpClientRequest) {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => error("unavailable")));
    if (response.status < 200 || response.status >= 300)
      return yield* error(
        response.status === 401 || response.status === 403 ? "authorization" : "unavailable",
      );
    let bytes = 0;
    return yield* response.stream.pipe(
      Stream.mapEffect((chunk) => {
        bytes += chunk.byteLength;
        return bytes > 512 * 1024 ? Effect.fail(error("response")) : Effect.succeed(chunk);
      }),
      Stream.decodeText(),
      Stream.mkString,
      Effect.flatMap(decodeJson),
      Effect.mapError(() => error("response")),
    );
  },
  Effect.scoped,
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  }),
  Effect.withTracerEnabled(false),
  Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(error("timeout")) }),
);

const get = (url: string, token: string, params?: Record<string, string>) => {
  const request = HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(token));
  return params ? HttpClientRequest.setUrlParams(request, params) : request;
};
const github = (route: "/user" | "/user/repos", token: string) =>
  get(`https://api.github.com${route}`, token).pipe(
    HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
    HttpClientRequest.setHeader("user-agent", "Hyakki"),
  );
const linear = (token: string, body: { query: string; variables?: { first: number } }) =>
  HttpClientRequest.post("https://api.linear.app/graphql").pipe(
    HttpClientRequest.setHeader("authorization", token),
    HttpClientRequest.bodyJsonUnsafe(body),
  );
const notionVersion = HttpClientRequest.setHeader("Notion-Version", "2026-03-11");
const field = (value: unknown, key: string): unknown => (object(value) ? value[key] : undefined);

// Accept a single bounded printable field, never provider error strings, URLs or whole objects.
const display = (value: unknown, token: string, max: number) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() &&
  !value.includes(token) &&
  !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    ? value.trim()
    : undefined;

const identifier = (value: unknown, token: string) => {
  const id = display(value, token, 120);
  return id && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id) ? id : undefined;
};

function notionTitle(page: Record<string, unknown>) {
  if (!object(page.properties)) return undefined;
  // The title property's key is user-renamable; its ID and type are stable.
  for (const key in page.properties) {
    const prop = page.properties[key];
    if (!object(prop) || prop.id !== "title" || prop.type !== "title") continue;
    if (!Array.isArray(prop.title)) return undefined;
    if (!prop.title.length) return "Untitled";
    let title = "";
    for (const span of prop.title) {
      const text = field(span, "plain_text");
      if (typeof text !== "string" || title.length + text.length > 256) return undefined;
      title += text;
    }
    return title;
  }
  return undefined;
}

const vercelProjects = (token: string, limit: number) =>
  get("https://api.vercel.com/v10/projects", token, { limit: String(limit) });
const vercelRows = (body: unknown) => (Array.isArray(body) ? body : field(body, "projects"));

interface Adapter {
  identity: (token: string) => HttpClientRequest.HttpClientRequest;
  account: (body: unknown, token: string) => string | undefined;
  list: (token: string, limit: number) => HttpClientRequest.HttpClientRequest;
  rows?: (body: unknown) => unknown;
  include?: (row: Record<string, unknown>) => boolean;
  label?: (row: Record<string, unknown>) => unknown;
}

const accountId = (body: unknown, token: string) => identifier(field(body, "id"), token);
const adapters: Record<VaultTokenService, Adapter> = {
  github: {
    identity: (token) => github("/user", token),
    account: (body, token) => identifier(field(body, "login"), token),
    list: (token, limit) =>
      github("/user/repos", token).pipe(HttpClientRequest.setUrlParam("per_page", String(limit))),
    label: (row) => row.full_name,
  },
  gitlab: {
    identity: (token) => get("https://gitlab.com/api/v4/user", token),
    account: (body, token) => identifier(field(body, "username"), token),
    list: (token, limit) =>
      get("https://gitlab.com/api/v4/projects", token, {
        membership: "true",
        simple: "true",
        per_page: String(limit),
      }),
    label: (row) => row.path_with_namespace,
  },
  slack: {
    identity: (token) =>
      HttpClientRequest.post("https://slack.com/api/auth.test").pipe(
        HttpClientRequest.bearerToken(token),
      ),
    account: (body, token) => {
      const team = display(field(body, "team_id"), token, 40);
      const user = display(field(body, "user_id"), token, 40);
      return team && user && /^T[A-Z0-9]+$/u.test(team) && /^[UW][A-Z0-9]+$/u.test(user)
        ? `${team} / ${user}`
        : undefined;
    },
    list: (token, limit) =>
      get("https://slack.com/api/conversations.list", token, {
        types: "public_channel",
        exclude_archived: "true",
        limit: String(limit),
      }),
    rows: (body) => field(body, "channels"),
    include: (row) =>
      row.is_channel === true && row.is_private === false && row.is_archived !== true,
  },
  airtable: {
    identity: (token) => get("https://api.airtable.com/v0/meta/whoami", token),
    account: accountId,
    // Airtable offers only an offset, not a page size. Never follow the offset.
    list: (token) => get("https://api.airtable.com/v0/meta/bases", token),
    rows: (body) => field(body, "bases"),
  },
  asana: {
    identity: (token) =>
      get("https://app.asana.com/api/1.0/users/me", token, { opt_fields: "gid" }),
    account: (body, token) => identifier(field(field(body, "data"), "gid"), token),
    list: (token, limit) =>
      get("https://app.asana.com/api/1.0/workspaces", token, {
        opt_fields: "name",
        limit: String(limit),
      }),
    rows: (body) => field(body, "data"),
  },
  linear: {
    identity: (token) => linear(token, { query: "query Viewer { viewer { id } }" }),
    account: (body, token) => accountId(field(body, "viewer"), token),
    list: (token, first) =>
      linear(token, {
        query: "query Teams($first: Int!) { teams(first: $first) { nodes { name } } }",
        variables: { first },
      }),
    rows: (body) => field(field(body, "teams"), "nodes"),
  },
  netlify: {
    identity: (token) => get("https://api.netlify.com/api/v1/user", token),
    account: accountId,
    list: (token, limit) =>
      get("https://api.netlify.com/api/v1/sites", token, { per_page: String(limit) }),
  },
  notion: {
    identity: (token) => get("https://api.notion.com/v1/users/me", token).pipe(notionVersion),
    account: (body, token) =>
      field(body, "object") === "user" && field(body, "type") === "bot"
        ? accountId(body, token)
        : undefined,
    list: (token, limit) =>
      HttpClientRequest.post("https://api.notion.com/v1/search").pipe(
        HttpClientRequest.bearerToken(token),
        notionVersion,
        HttpClientRequest.setUrlParam("filter_properties", "title"),
        HttpClientRequest.bodyJsonUnsafe({
          filter: { property: "object", value: "page" },
          page_size: limit,
        }),
      ),
    rows: (body) => field(body, "results"),
    include: (row) => row.object === "page" && row.in_trash !== true && row.archived !== true,
    label: notionTitle,
  },
  todoist: {
    identity: (token) => get("https://api.todoist.com/api/v1/user", token),
    account: accountId,
    list: (token, limit) =>
      get("https://api.todoist.com/api/v1/projects", token, { limit: String(limit) }),
    rows: (body) => field(body, "results"),
  },
  typeform: {
    identity: (token) => get("https://api.typeform.com/me", token),
    // /me documents an alias rather than an immutable ID. Don't return its email.
    account: (body, token) => {
      const alias = display(field(body, "alias"), token, 120);
      return alias && /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(alias) ? alias : undefined;
    },
    list: (token, limit) =>
      get("https://api.typeform.com/forms", token, { page_size: String(limit) }),
    rows: (body) => field(body, "items"),
    label: (row) => row.title,
  },
  vercel: {
    // A project-scoped token can list its projects but cannot read a user profile.
    identity: (token) => vercelProjects(token, 1),
    account: (body, token) => {
      const rows = vercelRows(body);
      if (!Array.isArray(rows) || (rows.length && !identifier(field(rows[0], "id"), token)))
        return undefined;
      return "Project access verified";
    },
    list: vercelProjects,
    rows: vercelRows,
  },
};

const readPayload = Effect.fnUntraced(function* (
  service: VaultTokenService,
  request: HttpClientRequest.HttpClientRequest,
) {
  const body = yield* requestJson(request);
  if (service === "slack" && field(body, "ok") !== true) return yield* error("authorization");
  if (service === "linear") {
    if (!object(body) || "errors" in body || !object(body.data)) return yield* error("response");
    return body.data;
  }
  return body;
});

export const verifyServiceIdentity = Effect.fnUntraced(function* (
  service: VaultTokenService,
  token: string,
) {
  if (!isVaultTokenService(service) || !validToken(token)) return yield* error("authorization");
  const adapter = adapters[service];
  const account = adapter.account(yield* readPayload(service, adapter.identity(token)), token);
  if (!account) return yield* error("response");
  return account;
});

export const listConnectedItems = Effect.fnUntraced(function* (
  connection: ServiceConnection,
  operation: VaultServiceRead,
): Effect.fn.Return<ReadonlyArray<VaultServiceItem>, ConnectionError> {
  if (!isVaultServiceRead(operation) || operation.service !== connection.service)
    return yield* error("operation");
  const { service, token } = connection;
  if (!validToken(token)) return yield* error("authorization");
  const adapter = adapters[service];
  const body = yield* readPayload(service, adapter.list(token, operation.limit));
  const rows = adapter.rows ? adapter.rows(body) : body;
  if (!Array.isArray(rows)) return yield* error("response");
  const items: VaultServiceItem[] = [];
  for (const row of rows) {
    if (!object(row)) return yield* error("response");
    if (adapter.include && !adapter.include(row)) continue;
    const label = display(adapter.label ? adapter.label(row) : row.name, token, 256);
    if (!label) return yield* error("response");
    items.push({ label });
    if (items.length === operation.limit) break;
  }
  return items;
});
