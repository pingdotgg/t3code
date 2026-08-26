import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CodexError from "../errors.ts";

export const JsonRpcId = Schema.Union([Schema.Number, Schema.String]);

export const JsonRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});

export const JsonRpcResponseEnvelope = Schema.Struct({
  id: JsonRpcId,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcError),
});

const PINNED_PLAN_TYPES = new Set<string>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "edu_plus",
  "edu_pro",
  "unknown",
]);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizePlanTypeField = (value: unknown): unknown => {
  if (
    !isObject(value) ||
    typeof value.planType !== "string" ||
    PINNED_PLAN_TYPES.has(value.planType)
  ) {
    return value;
  }
  return { ...value, planType: "unknown" };
};

const normalizeField = (
  value: unknown,
  field: string,
  normalize: (child: unknown) => unknown,
): unknown => {
  if (!isObject(value)) {
    return value;
  }
  const current = value[field];
  const normalized = normalize(current);
  return normalized === current ? value : { ...value, [field]: normalized };
};

const normalizeRateLimitsById = (value: unknown): unknown => {
  if (!isObject(value)) {
    return value;
  }

  let normalized: JsonObject | undefined;
  for (const [limitId, snapshot] of Object.entries(value)) {
    const normalizedSnapshot = normalizePlanTypeField(snapshot);
    if (normalizedSnapshot !== snapshot) {
      normalized ??= { ...value };
      normalized[limitId] = normalizedSnapshot;
    }
  }
  return normalized ?? value;
};

export const normalizeAccountPlanTypes = (method: string, raw: unknown): unknown => {
  switch (method) {
    case "account/read":
      return normalizeField(raw, "account", normalizePlanTypeField);
    case "account/rateLimits/read":
      return normalizeField(
        normalizeField(raw, "rateLimits", normalizePlanTypeField),
        "rateLimitsByLimitId",
        normalizeRateLimitsById,
      );
    case "account/updated":
      return normalizePlanTypeField(raw);
    case "account/rateLimits/updated":
      return normalizeField(raw, "rateLimits", normalizePlanTypeField);
    default:
      return raw;
  }
};

export const decodeOptionalPayload = <A, I>(
  method: string,
  schema: Schema.Codec<A, I> | undefined,
  raw: unknown,
): Effect.Effect<A, CodexError.CodexAppServerRequestError> => {
  if (!schema) {
    if (raw === undefined) {
      return Effect.sync(() => undefined as A);
    }
    return Effect.fail(
      CodexError.CodexAppServerRequestError.unexpectedPayload(method, "decode-payload", raw),
    );
  }

  return Schema.decodeUnknownEffect(schema)(normalizeAccountPlanTypes(method, raw)).pipe(
    Effect.mapError((error) =>
      CodexError.CodexAppServerRequestError.invalidPayload(method, "decode-payload", error),
    ),
  );
};

export const encodeOptionalPayload = <A, I>(
  method: string,
  schema: Schema.Codec<A, I> | undefined,
  payload: A,
): Effect.Effect<I | undefined, CodexError.CodexAppServerRequestError> => {
  if (!schema) {
    if (payload === undefined) {
      return Effect.sync(() => undefined);
    }
    return Effect.fail(
      CodexError.CodexAppServerRequestError.unexpectedPayload(method, "encode-payload", payload),
    );
  }

  return Schema.encodeEffect(schema)(payload).pipe(
    Effect.mapError((error) =>
      CodexError.CodexAppServerRequestError.invalidPayload(method, "encode-payload", error),
    ),
  );
};

export const decodeNotificationPayload = <A, I>(
  method: string,
  schema: Schema.Codec<A, I> | undefined,
  raw: unknown,
): Effect.Effect<A, CodexError.CodexAppServerProtocolParseError> =>
  decodeOptionalPayload(method, schema, raw).pipe(
    Effect.mapError((error) =>
      CodexError.CodexAppServerProtocolParseError.fromRequestError(
        "decode-notification-payload",
        method,
        error,
      ),
    ),
  );

export const runHandler = Effect.fnUntraced(function* <A, B>(
  handler: ((payload: A) => Effect.Effect<B, CodexError.CodexAppServerError>) | undefined,
  payload: A,
  method: string,
) {
  if (!handler) {
    return yield* CodexError.CodexAppServerRequestError.methodNotFound(method);
  }

  return yield* handler(payload).pipe(
    Effect.mapError((error) =>
      CodexError.CodexAppServerRequestError.fromAppServerError(error, method),
    ),
  );
});
