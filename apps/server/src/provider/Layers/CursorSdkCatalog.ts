import type { SDKModel, SDKUser } from "@cursor/sdk";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { loadCursorSdk } from "../cursorSdk.ts";

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

export interface CursorSdkCatalogProbes {
  readonly readUser: (apiKey: string) => Effect.Effect<SDKUser, CursorSdkCatalogError>;
  readonly readModels: (
    apiKey: string,
  ) => Effect.Effect<ReadonlyArray<SDKModel>, CursorSdkCatalogError>;
}

const sdkRequest = <A>(request: (sdk: ReturnType<typeof loadCursorSdk>) => Promise<A>) =>
  Effect.try({
    try: loadCursorSdk,
    catch: (cause) => new CursorSdkCatalogError({ authenticationFailure: false, cause }),
  }).pipe(
    Effect.flatMap((sdk) =>
      Effect.tryPromise({
        try: () => request(sdk),
        catch: (cause) =>
          new CursorSdkCatalogError({
            authenticationFailure:
              cause instanceof sdk.AuthenticationError ||
              (cause instanceof sdk.CursorSdkError && cause.status === 401),
            cause,
          }),
      }),
    ),
  );

const liveProbes: CursorSdkCatalogProbes = {
  readUser: (apiKey) => sdkRequest((sdk) => sdk.Cursor.me({ apiKey })),
  readModels: (apiKey) => sdkRequest((sdk) => sdk.Cursor.models.list({ apiKey })),
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
