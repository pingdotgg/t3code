import type {
  GitHubIssueActor,
  GitHubIssueComment,
  GitHubIssueLabel,
  GitHubIssueState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const RawActor = Schema.Struct({
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(RawActor),
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

const RawIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  author: Schema.NullOr(RawActor),
  assignees: Schema.Array(RawActor),
  labels: Schema.Array(RawLabel),
  state: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  body: Schema.optional(Schema.String),
  comments: Schema.optional(Schema.Array(RawComment)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeIssueList = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(RawIssue)));
const decodeIssueDetail = Schema.decodeEffect(Schema.fromJsonString(RawIssue));

type RawActor = typeof RawActor.Type;
type RawLabel = typeof RawLabel.Type;
type RawComment = typeof RawComment.Type;
export type RawGitHubIssue = typeof RawIssue.Type;

function actor(raw: RawActor): GitHubIssueActor {
  return {
    login: raw.login,
    name: raw.name ?? null,
    avatarUrl: raw.avatarUrl ?? null,
  };
}

function label(raw: RawLabel): GitHubIssueLabel {
  return { name: raw.name, color: raw.color ?? null };
}

function state(raw: string): GitHubIssueState {
  return raw.toLowerCase() === "closed" ? "closed" : "open";
}

export function normalizeGitHubIssue(raw: RawGitHubIssue) {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author === null ? null : actor(raw.author),
    assignees: raw.assignees.map(actor),
    labels: raw.labels.map(label),
    state: state(raw.state),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function comment(raw: RawComment, issueUrl: string): GitHubIssueComment {
  return {
    id: raw.id,
    author: raw.author === null ? null : actor(raw.author),
    body: raw.body,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt ?? raw.createdAt,
    url: raw.url ?? issueUrl,
  };
}

export const decodeGitHubIssueList = Effect.fn("decodeGitHubIssueList")(function* (raw: string) {
  const decoded = yield* decodeIssueList(raw);
  return decoded.map(normalizeGitHubIssue);
});

export const decodeGitHubIssueDetail = Effect.fn("decodeGitHubIssueDetail")(function* (
  raw: string,
) {
  const decoded = yield* decodeIssueDetail(raw);
  return {
    ...normalizeGitHubIssue(decoded),
    body: decoded.body ?? "",
    comments: (decoded.comments ?? []).map((entry) => comment(entry, decoded.url)),
    closedAt: decoded.closedAt ?? null,
  };
});
