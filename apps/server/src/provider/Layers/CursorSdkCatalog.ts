import {
  AuthenticationError,
  Cursor,
  CursorSdkError,
  type SDKModel,
  type SDKUser,
} from "@cursor/sdk";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface CursorSdkCatalogSnapshot {
  readonly user: SDKUser;
  readonly models: ReadonlyArray<SDKModel>;
}

export class CursorSdkCatalogError extends Schema.TaggedError<CursorSdkCatalogError>()(
  "CursorSdkCatalogError",
  {
    authenticationFailure: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.authenticationFailure
      ? "Cursor SDK authentication failed."
      : "Cursor SDK catalog request failed.";
  }
}

export interface CursorSdkCatalogShape {
  readonly read: (apiKey: string) => Effect.Effect<CursorSdkCatalogSnapshot, CursorSdkCatalogError>;
}

export class CursorSdkCatalog extends Context.Service<CursorSdkCatalog, CursorSdkCatalogShape>()(
  "t3/provider/Layers/CursorSdkCatalog",
) {}

function isAuthenticationFailure(cause: unknown): boolean {
  return (
    cause instanceof AuthenticationError ||
    (cause instanceof CursorSdkError && cause.status === 401)
  );
}

export interface CursorSdkCatalogProbes {
  readonly readUser: (apiKey: string) => Effect.Effect<SDKUser, CursorSdkCatalogError>;
  readonly readModels: (
    apiKey: string,
  ) => Effect.Effect<ReadonlyArray<SDKModel>, CursorSdkCatalogError>;
}

const sdkRequest = <A>(tryRequest: () => Promise<A>) =>
  Effect.tryPromise({
    try: tryRequest,
    catch: (cause) =>
      new CursorSdkCatalogError({
        authenticationFailure: isAuthenticationFailure(cause),
        cause,
      }),
  });

const liveProbes: CursorSdkCatalogProbes = {
  readUser: (apiKey) => sdkRequest(() => Cursor.me({ apiKey })),
  readModels: (apiKey) => sdkRequest(() => Cursor.models.list({ apiKey })),
};

export const makeCursorSdkCatalog = Effect.fn("CursorSdkCatalog.make")(function* (
  probes: CursorSdkCatalogProbes = liveProbes,
) {
  const modelCache = yield* Cache.makeWith(probes.readModels, {
    capacity: 32,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.length > 0 ? Duration.minutes(30) : Duration.zero,
  });
  return CursorSdkCatalog.of({
    read: (apiKey) =>
      Effect.all(
        {
          user: probes.readUser(apiKey),
          models: Cache.get(modelCache, apiKey),
        },
        { concurrency: "unbounded" },
      ),
  });
});

export const CursorSdkCatalogLive = Layer.effect(CursorSdkCatalog, makeCursorSdkCatalog());

export function makeCursorSdkCatalogTestLayer(
  read: CursorSdkCatalogShape["read"],
): Layer.Layer<CursorSdkCatalog> {
  return Layer.succeed(CursorSdkCatalog, CursorSdkCatalog.of({ read }));
}
