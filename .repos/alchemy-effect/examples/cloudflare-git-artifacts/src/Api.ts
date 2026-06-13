import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

// ─── Domain types ────────────────────────────────────────────────────

export class Metadata extends Schema.Class<Metadata>("Metadata")({
  description: Schema.String,
  topics: Schema.Array(Schema.String),
  stars: Schema.Number,
  createdAt: Schema.Number,
}) {}

export class RepoInfo extends Schema.Class<RepoInfo>("RepoInfo")({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  defaultBranch: Schema.String,
  remote: Schema.String,
  status: Schema.String,
  readOnly: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastPushAt: Schema.NullOr(Schema.String),
  metadata: Schema.NullOr(Metadata),
}) {}

export class CreateRepoResponse extends Schema.Class<CreateRepoResponse>(
  "CreateRepoResponse",
)({
  name: Schema.String,
  remote: Schema.String,
  token: Schema.String,
  defaultBranch: Schema.String,
}) {}

export class CloneToken extends Schema.Class<CloneToken>("CloneToken")({
  id: Schema.String,
  plaintext: Schema.String,
  scope: Schema.Literals(["read", "write"]),
  expiresAt: Schema.String,
}) {}

// ─── Errors ─────────────────────────────────────────────────────────

export class RepoNotFound extends Schema.TaggedErrorClass<RepoNotFound>()(
  "RepoNotFound",
  { name: Schema.String },
) {}

export class RepoConflict extends Schema.TaggedErrorClass<RepoConflict>()(
  "RepoConflict",
  { message: Schema.String },
) {}

// ─── Path / payload schemas ──────────────────────────────────────────

const RepoNameParam = Schema.Struct({ name: Schema.String });

const CreateRepoPayload = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
});

const UpdateRepoPayload = Schema.Struct({
  description: Schema.optional(Schema.String),
  topics: Schema.optional(Schema.Array(Schema.String)),
});

const CloneTokenPayload = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["read", "write"])),
  ttl: Schema.optional(Schema.Number),
});

// ─── Endpoints ──────────────────────────────────────────────────────

export const createRepo = HttpApiEndpoint.post("createRepo", "/repos", {
  payload: CreateRepoPayload,
  success: CreateRepoResponse,
  error: RepoConflict,
});

export const getRepo = HttpApiEndpoint.get("getRepo", "/repos/:name", {
  params: RepoNameParam,
  success: RepoInfo,
  error: RepoNotFound,
});

export const updateRepo = HttpApiEndpoint.patch("updateRepo", "/repos/:name", {
  params: RepoNameParam,
  payload: UpdateRepoPayload,
  success: Metadata,
  error: RepoNotFound,
});

export const deleteRepo = HttpApiEndpoint.delete("deleteRepo", "/repos/:name", {
  params: RepoNameParam,
  success: HttpApiSchema.NoContent,
  error: RepoNotFound,
});

export const starRepo = HttpApiEndpoint.post("starRepo", "/repos/:name/star", {
  params: RepoNameParam,
  success: Metadata,
  error: RepoNotFound,
});

export const cloneToken = HttpApiEndpoint.post(
  "cloneToken",
  "/repos/:name/clone-token",
  {
    params: RepoNameParam,
    payload: CloneTokenPayload,
    success: CloneToken,
    error: RepoNotFound,
  },
);

export class ReposGroup extends HttpApiGroup.make("repos")
  .add(createRepo)
  .add(getRepo)
  .add(updateRepo)
  .add(deleteRepo)
  .add(starRepo)
  .add(cloneToken) {}

export class RepoApi extends HttpApi.make("RepoApi").add(ReposGroup) {}
