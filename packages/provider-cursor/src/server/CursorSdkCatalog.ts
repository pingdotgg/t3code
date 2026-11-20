import type { SDKModel, SDKUser } from "@cursor/sdk";
import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface CursorSdkCatalogSnapshot {
  readonly user: SDKUser | undefined;
  readonly models: ReadonlyArray<SDKModel>;
}

export class CursorSdkCatalogError extends Schema.TaggedError<CursorSdkCatalogError>()(
  "CursorSdkCatalogError",
  {
    authenticationFailure: Schema.Boolean,
    status: Schema.optionalKey(Schema.Number),
    code: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.authenticationFailure
      ? "Cursor SDK authentication failed."
      : "Cursor SDK catalog request failed.";
  }

  get planRequired(): boolean {
    return this.code === "plan_required";
  }

  get accountBlocked(): boolean {
    return this.status === 403 && !this.planRequired;
  }
}

export class CursorSdkCatalog extends Context.Service<
  CursorSdkCatalog,
  {
    readonly read: (
      apiKey: string,
    ) => Effect.Effect<CursorSdkCatalogSnapshot, CursorSdkCatalogError>;
  }
>()("@t3tools/provider-cursor/server/CursorSdkCatalog") {}

export interface CursorSdkCatalogProbes {
  readonly readUser: (apiKey: string) => Effect.Effect<SDKUser, CursorSdkCatalogError>;
  readonly readModels: (
    apiKey: string,
  ) => Effect.Effect<ReadonlyArray<SDKModel>, CursorSdkCatalogError>;
}

const CatalogUser = Schema.Struct({
  apiKeyName: Schema.String,
  createdAt: Schema.String,
  userId: Schema.optionalKey(Schema.Number),
  userEmail: Schema.optionalKey(Schema.String),
  userFirstName: Schema.optionalKey(Schema.String),
  userLastName: Schema.optionalKey(Schema.String),
});
const ModelParameterValue = Schema.Struct({ id: Schema.String, value: Schema.String });
const CatalogModel = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.optionalKey(Schema.String),
  aliases: Schema.optionalKey(Schema.Array(Schema.String).pipe(Schema.mutable)),
  parameters: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        displayName: Schema.optionalKey(Schema.String),
        values: Schema.Array(
          Schema.Struct({ value: Schema.String, displayName: Schema.optionalKey(Schema.String) }),
        ).pipe(Schema.mutable),
      }),
    ).pipe(Schema.mutable),
  ),
  variants: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        params: Schema.Array(ModelParameterValue).pipe(Schema.mutable),
        displayName: Schema.String,
        description: Schema.optionalKey(Schema.String),
        isDefault: Schema.optionalKey(Schema.Boolean),
        isMaxMode: Schema.optionalKey(Schema.Boolean),
      }),
    ).pipe(Schema.mutable),
  ),
});
const CatalogModels = Schema.Struct({ items: Schema.Array(CatalogModel).pipe(Schema.mutable) });
const ApiError = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
const ApiErrorEnvelope = Schema.Struct({ error: ApiError });
const decodeApiError = Schema.decodeUnknownOption(ApiError);
const decodeApiErrorEnvelope = Schema.decodeUnknownOption(ApiErrorEnvelope);
const isCatalogError = Schema.is(CursorSdkCatalogError);

// Catalog discovery uses public HTTP routes so signed-in startup does not initialize the agent runtime.
const makeLiveProbes = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const baseUrl = (yield* Config.String("CURSOR_BACKEND_URL").pipe(
    Config.withDefault("https://api.cursor.com"),
    Effect.orDie,
  )).replace(/\/$/, "");
  const request = Effect.fn("CursorSdkCatalog.request")(function* (apiKey: string, path: string) {
    const response = yield* client
      .execute(
        HttpClientRequest.get(`${baseUrl}${path}`).pipe(HttpClientRequest.bearerToken(apiKey)),
      )
      .pipe(
        Effect.mapError(
          (cause) => new CursorSdkCatalogError({ authenticationFailure: false, cause }),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
      const nested = decodeApiErrorEnvelope(body);
      const parsed = Option.isSome(nested) ? Option.some(nested.value.error) : decodeApiError(body);
      const error = Option.getOrUndefined(parsed);
      return yield* new CursorSdkCatalogError({
        authenticationFailure: response.status === 401,
        status: response.status,
        ...(error?.code === undefined ? {} : { code: error.code }),
        cause: new Error(error?.message ?? `Cursor ${path} returned HTTP ${response.status}.`),
      });
    }
    return response;
  });
  return {
    readUser: (apiKey) =>
      request(apiKey, "/v1/me").pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(CatalogUser)),
        Effect.mapError((cause) =>
          isCatalogError(cause)
            ? cause
            : new CursorSdkCatalogError({ authenticationFailure: false, cause }),
        ),
      ),
    readModels: (apiKey) =>
      request(apiKey, "/v1/models").pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(CatalogModels)),
        Effect.map((body) => body.items),
        Effect.mapError((cause) =>
          isCatalogError(cause)
            ? cause
            : new CursorSdkCatalogError({ authenticationFailure: false, cause }),
        ),
      ),
  } satisfies CursorSdkCatalogProbes;
});

export const makeCursorSdkCatalog = Effect.fn("CursorSdkCatalog.make")(function* (
  probes: CursorSdkCatalogProbes,
) {
  const modelCache = yield* Cache.makeWith(probes.readModels, {
    capacity: 32,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.length > 0 ? Duration.minutes(30) : Duration.zero,
  });
  return CursorSdkCatalog.of({
    read: Effect.fn("CursorSdkCatalog.read")(function (apiKey) {
      return Effect.all(
        {
          // Enterprise teams can block account labels while model discovery still works.
          user: Effect.catchIf(
            probes.readUser(apiKey),
            (error: CursorSdkCatalogError): boolean => error.accountBlocked,
            () => Effect.undefined,
            (error: CursorSdkCatalogError) => Effect.fail(error),
          ),
          models: Cache.get(modelCache, apiKey),
        },
        { concurrency: "unbounded" },
      );
    }),
  });
});

export const layer = Layer.effect(
  CursorSdkCatalog,
  Effect.flatMap(makeLiveProbes, makeCursorSdkCatalog),
);

export function layerTest(
  read: CursorSdkCatalog["Service"]["read"],
): Layer.Layer<CursorSdkCatalog> {
  return Layer.succeed(CursorSdkCatalog, CursorSdkCatalog.of({ read }));
}
