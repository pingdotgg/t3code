import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { UserFacingError } from "../UserFacingError.ts";

/**
 * Resource-state payload shape on the wire.
 *
 * Pinned to JSON encoding via {@link HttpApiSchema.asJson} so that both
 * sides of the API agree on `Content-Type: application/json`. With a
 * bare `Schema.Any` the server's payload-decoder map is keyed off the
 * default content type only — any client request that arrives with a
 * differently-shaped body (or a transport that drops the
 * `Content-Type` header entirely) falls into the `payloadBy.get(
 * contentType)` miss branch in `HttpApiBuilder.decodePayload` and
 * surfaces as a confusing `415 Unsupported Media Type`. Annotating
 * the schema makes the encoding explicit on both endpoints and the
 * client encoder, so the wire format is unambiguous.
 */
export const ResourceStateSchema = Schema.Any.pipe(HttpApiSchema.asJson());

export class BearerTokenValidator extends Context.Service<
  BearerTokenValidator,
  {
    readonly validate: (token: string) => Effect.Effect<void, HttpApiError.Unauthorized>;
  }
>()("alchemy/State/BearerTokenValidator") {}

export class StateAuth extends HttpApiMiddleware.Service<
  StateAuth,
  { requires: BearerTokenValidator }
>()("alchemy/State/StateAuth", {
  security: {
    bearer: HttpApiSecurity.bearer,
  },
  error: HttpApiError.UnauthorizedNoContent,
}) {}

export const StateAuthLive: Layer.Layer<StateAuth, never, BearerTokenValidator> = Layer.effect(
  StateAuth,
  Effect.gen(function* () {
    const validator = yield* BearerTokenValidator;
    return {
      bearer: (httpEffect, { credential }) =>
        validator.validate(Redacted.value(credential)).pipe(Effect.flatMap(() => httpEffect)),
    };
  }),
);

/** `stack` path segment for nested REST resources. */
const StackParams = Schema.Struct({
  stack: Schema.String,
});

/** Optional stage selector for stack deletion. */
const OptionalStageQuery = Schema.Struct({
  stage: Schema.optional(Schema.String),
});

/** `(stack, stage)` path segments shared by stage-scoped endpoints. */
const StackStage = Schema.Struct({
  stack: Schema.String,
  stage: Schema.String,
});

/** `(stack, stage, fqn)` path segments for a single resource. */
const ResourceKey = Schema.Struct({
  stack: Schema.String,
  stage: Schema.String,
  fqn: Schema.String,
});

/**
 * The store failed to serve a request: which operation, and the kind of
 * failure (its tag). Never the failure's message, which can carry state; the
 * Worker logs the full cause. Without it, any failure behind the auth
 * middleware was encoded as its `Unauthorized` and surfaced as a bare 500.
 */
export class StateStoreFailure extends Schema.TaggedError<StateStoreFailure>()(
  "StateStoreFailure",
  { operation: Schema.String, reason: Schema.String },
  { httpApiStatus: 500 },
) {
  readonly [UserFacingError] = true;
  override get message() {
    return `State store failed to ${this.operation} (${this.reason}); its logs have the cause`;
  }
}

export const ListStacks = HttpApiEndpoint.get("listStacks", "/state/stacks", {
  success: Schema.Array(Schema.String),
  error: StateStoreFailure,
});

export const ListStages = HttpApiEndpoint.get("listStages", "/state/stacks/:stack/stages", {
  params: StackParams,
  success: Schema.Array(Schema.String),
  error: StateStoreFailure,
});

export const ListResources = HttpApiEndpoint.get(
  "listResources",
  "/state/stacks/:stack/stages/:stage/resources",
  {
    params: StackStage,
    success: Schema.Array(Schema.String),
    error: StateStoreFailure,
  },
);

export const GetState = HttpApiEndpoint.get(
  "getState",
  "/state/stacks/:stack/stages/:stage/resources/:fqn",
  {
    params: ResourceKey,
    success: Schema.UndefinedOr(ResourceStateSchema),
    error: StateStoreFailure,
  },
);

export const SetState = HttpApiEndpoint.put(
  "setState",
  "/state/stacks/:stack/stages/:stage/resources/:fqn",
  {
    params: ResourceKey,
    payload: ResourceStateSchema,
    success: ResourceStateSchema,
    error: StateStoreFailure,
  },
);

export const DeleteState = HttpApiEndpoint.delete(
  "deleteState",
  "/state/stacks/:stack/stages/:stage/resources/:fqn",
  {
    params: ResourceKey,
    success: HttpApiSchema.NoContent,
    error: StateStoreFailure,
  },
);

export const DeleteStack = HttpApiEndpoint.delete("deleteStack", "/state/stacks/:stack", {
  params: StackParams,
  query: OptionalStageQuery,
  success: HttpApiSchema.NoContent,
  error: StateStoreFailure,
});

export const GetReplacedResources = HttpApiEndpoint.get(
  "getReplacedResources",
  "/state/stacks/:stack/stages/:stage/replaced-resources",
  {
    params: StackStage,
    success: Schema.Array(ResourceStateSchema),
    error: StateStoreFailure,
  },
);

export const GetStackOutput = HttpApiEndpoint.get(
  "getStackOutput",
  "/state/stacks/:stack/stages/:stage/output",
  {
    params: StackStage,
    success: Schema.UndefinedOr(ResourceStateSchema),
    error: StateStoreFailure,
  },
);

export const SetStackOutput = HttpApiEndpoint.put(
  "setStackOutput",
  "/state/stacks/:stack/stages/:stage/output",
  {
    params: StackStage,
    payload: ResourceStateSchema,
    success: ResourceStateSchema,
    error: StateStoreFailure,
  },
);

/**
 * Version of the State Store wire / behavioural contract.
 *
 * Bump this whenever the wire format or runtime behaviour of an HTTP
 * state-store changes in a way that an older deployed copy can no
 * longer satisfy. Clients query `/version` on the deployed worker and
 * compare against this constant; a mismatch (or 404) triggers a
 * forced redeploy via the bootstrap flow.
 */
export const STATE_STORE_VERSION = 5 as const;

/** Response shape for the unauthenticated `/version` probe. */
export const VersionResponse = Schema.Struct({
  version: Schema.Number,
});

/**
 * Unauthenticated probe so clients can detect a stale (or absent)
 * deployed worker without holding a valid bearer token. The returned
 * version is bumped whenever the wire / behavioural contract changes
 * in a way that requires a redeploy.
 */
export const GetVersion = HttpApiEndpoint.get("getVersion", "/version", {
  success: VersionResponse,
});

export class StateGroup extends HttpApiGroup.make("state")
  .add(ListStacks)
  .add(ListStages)
  .add(ListResources)
  .add(GetState)
  .add(SetState)
  .add(DeleteState)
  .add(GetReplacedResources)
  .add(DeleteStack)
  .add(GetStackOutput)
  .add(SetStackOutput)
  .middleware(StateAuth) {}

export class VersionGroup extends HttpApiGroup.make("version").add(GetVersion) {}

export class StateApi extends HttpApi.make("alchemy-state").add(StateGroup).add(VersionGroup) {}
