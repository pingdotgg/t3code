/**
 * ClickUp's REST API (v2), signed with the personal token saved in Settings. A refusal for rate
 * reasons is HTTP 429 with an `X-RateLimit-Reset` epoch; a bad token is a 401 naming the token.
 */
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import { CLICKUP_KIND } from "../shared/issueUrl.ts";

export const KIND = CLICKUP_KIND;
const DEFAULT_API_URL = "https://api.clickup.com/api/v2";

const ClickUpApiConfig = Config.all({
  apiUrl: Config.String("T3CODE_CLICKUP_API_URL").pipe(Config.withDefault(DEFAULT_API_URL)),
});

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const ClickUpUser = Schema.Struct({
  id: Schema.Number,
  username: OptionalString,
  email: OptionalString,
  profilePicture: OptionalString,
});
export type ClickUpUser = typeof ClickUpUser.Type;

const ClickUpStatus = Schema.Struct({
  status: Schema.String,
  type: Schema.String,
  color: OptionalString,
  orderindex: Schema.optional(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
});
export type ClickUpStatus = typeof ClickUpStatus.Type;

const ClickUpTag = Schema.Struct({
  name: Schema.String,
  tag_bg: OptionalString,
});
export type ClickUpTag = typeof ClickUpTag.Type;

const ClickUpTask = Schema.Struct({
  id: Schema.String,
  custom_id: OptionalString,
  name: Schema.String,
  url: Schema.String,
  status: ClickUpStatus,
  date_created: Schema.String,
  date_updated: OptionalString,
  date_closed: OptionalString,
  date_done: OptionalString,
  creator: Schema.optional(Schema.NullOr(ClickUpUser)),
  assignees: Schema.Array(ClickUpUser),
  watchers: Schema.optional(Schema.Array(ClickUpUser)),
  tags: Schema.Array(ClickUpTag),
  list: Schema.Struct({ id: Schema.String }),
  permission_level: OptionalString,
  team_id: OptionalString,
  description: OptionalString,
  markdown_description: OptionalString,
});
export type ClickUpTask = typeof ClickUpTask.Type;

const ClickUpComment = Schema.Struct({
  id: Schema.String,
  comment_text: Schema.String,
  user: Schema.NullOr(ClickUpUser),
  date: Schema.String,
});
export type ClickUpComment = typeof ClickUpComment.Type;

const ClickUpList = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  space: Schema.Struct({ id: Schema.String }),
  statuses: Schema.optional(Schema.Array(ClickUpStatus)),
});
export type ClickUpList = typeof ClickUpList.Type;

const Named = Schema.Struct({ id: Schema.String, name: Schema.String });

/** Each answer's decoder, compiled once. */
export const Responses = {
  user: Schema.decodeUnknownEffect(Schema.Struct({ user: ClickUpUser })),
  teams: Schema.decodeUnknownEffect(
    Schema.Struct({
      teams: Schema.Array(
        Schema.Struct({
          ...Named.fields,
          members: Schema.optional(Schema.Array(Schema.Struct({ user: ClickUpUser }))),
        }),
      ),
    }),
  ),
  spaces: Schema.decodeUnknownEffect(Schema.Struct({ spaces: Schema.Array(Named) })),
  folders: Schema.decodeUnknownEffect(
    Schema.Struct({
      folders: Schema.Array(Schema.Struct({ ...Named.fields, lists: Schema.Array(Named) })),
    }),
  ),
  lists: Schema.decodeUnknownEffect(Schema.Struct({ lists: Schema.Array(Named) })),
  list: Schema.decodeUnknownEffect(ClickUpList),
  members: Schema.decodeUnknownEffect(Schema.Struct({ members: Schema.Array(ClickUpUser) })),
  tags: Schema.decodeUnknownEffect(Schema.Struct({ tags: Schema.Array(ClickUpTag) })),
  task: Schema.decodeUnknownEffect(ClickUpTask),
  tasks: Schema.decodeUnknownEffect(
    Schema.Struct({
      tasks: Schema.Array(ClickUpTask),
      last_page: Schema.optional(Schema.Boolean),
    }),
  ),
  comments: Schema.decodeUnknownEffect(Schema.Struct({ comments: Schema.Array(ClickUpComment) })),
  ignored: Schema.decodeUnknownEffect(Schema.Unknown),
};

type Query = Readonly<
  Record<string, string | number | boolean | ReadonlyArray<string> | undefined>
>;

export interface ClickUpRequest<A> {
  readonly operation: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>;
  readonly query?: Query | undefined;
  readonly body?: unknown;
  /** A token being vetted; absent signs with the stored one. */
  readonly token?: string | undefined;
}

export class ClickUpApi extends Context.Service<
  ClickUpApi,
  {
    readonly request: <A>(request: ClickUpRequest<A>) => Effect.Effect<A, IssueTrackerError>;
  }
>()("@t3tools/issue-tracker-clickup/server/ClickUpApi") {}

const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  extra: { readonly retryAt?: number | undefined; readonly cause?: unknown } = {},
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(extra.retryAt === undefined ? {} : { retryAt: extra.retryAt }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });

/** ClickUp says "Unix timestamp" without a unit; ten digits is seconds, thirteen milliseconds. */
function resetAtFromHeader(value: string | undefined, now: number): number | undefined {
  const raw = value?.trim() ?? "";
  if (!/^\d+$/u.test(raw)) return undefined;
  const resetAt = raw.length <= 10 ? Number(raw) * 1000 : Number(raw);
  return Number.isSafeInteger(resetAt) && resetAt > now ? resetAt : undefined;
}

const ErrorBody = Schema.Struct({ err: Schema.optional(Schema.String), ECODE: OptionalString });
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

export const make = Effect.gen(function* () {
  // Only a default-carrying string: nothing in the environment can make it fail.
  const config = yield* ClickUpApiConfig.pipe(Effect.orDie);
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const storedToken = (operation: string) =>
    host.credentials
      .get(KIND)
      .pipe(
        Effect.flatMap(
          Effect.fromOption(() =>
            fail(operation, "unauthenticated", "ClickUp is not connected on this server."),
          ),
        ),
      );

  const request = Effect.fn("ClickUpApi.request")(function* <A>(input: ClickUpRequest<A>) {
    yield* Effect.annotateCurrentSpan({ "clickup.operation": input.operation });
    const token = input.token ?? (yield* storedToken(input.operation));
    let built = HttpClientRequest.make(input.method)(`${config.apiUrl}${input.path}`).pipe(
      // A personal token goes in as-is; `Bearer` is for OAuth tokens, which this is not.
      HttpClientRequest.setHeaders({ authorization: token, accept: "application/json" }),
    );
    for (const [name, value] of Object.entries(input.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value)
          built = HttpClientRequest.appendUrlParam(built, `${name}[]`, item);
      } else {
        built = HttpClientRequest.appendUrlParam(built, name, String(value));
      }
    }
    if (input.body !== undefined) built = HttpClientRequest.bodyJsonUnsafe(built, input.body);

    const response = yield* httpClient
      .execute(built)
      .pipe(
        Effect.mapError((cause) =>
          fail(input.operation, "failed", "ClickUp could not be reached.", { cause }),
        ),
      );
    const json = yield* response.json.pipe(Effect.orElseSucceed((): unknown => null));
    if (response.status >= 200 && response.status < 300) {
      return yield* input
        .decode(json)
        .pipe(
          Effect.mapError((cause) =>
            fail(input.operation, "failed", "ClickUp returned an unexpected body.", { cause }),
          ),
        );
    }
    // ClickUp's own wording stays in `cause`; the detail is built from the status and code.
    const body = decodeErrorBody(json);
    const ecode = body._tag === "Some" ? body.value.ECODE?.trim() : undefined;
    const code = ecode !== undefined && /^[A-Z]+_\d{1,4}$/.test(ecode) ? ecode : undefined;
    const cause = { status: response.status, body: json };
    if (response.status === 429) {
      const now = yield* Clock.currentTimeMillis;
      return yield* fail(input.operation, "rate-limited", "ClickUp's rate limit was reached.", {
        retryAt: resetAtFromHeader(response.headers["x-ratelimit-reset"], now),
        cause,
      });
    }
    // An id this token cannot see, missing or in another workspace, is OAUTH_027, not a 404.
    if (response.status === 404 || code === "OAUTH_027") {
      return yield* fail(
        input.operation,
        "not-found",
        "ClickUp has no such item, or this account cannot see it.",
        { cause },
      );
    }
    if (response.status === 401) {
      return yield* fail(input.operation, "unauthenticated", "ClickUp rejected the API token.", {
        cause,
      });
    }
    return yield* fail(
      input.operation,
      "failed",
      `ClickUp refused the request (HTTP ${response.status}${code === undefined ? "" : `, ${code}`}).`,
      { cause },
    );
  });

  return ClickUpApi.of({ request });
});

export const layer = Layer.effect(ClickUpApi, make);
