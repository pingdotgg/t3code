import {
  AuthenticationError,
  Cursor,
  CursorSdkError,
  type SDKModel,
  type SDKUser,
} from "@cursor/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface CursorSdkCatalogSnapshot {
  readonly user: SDKUser;
  readonly models: ReadonlyArray<SDKModel>;
}

export class CursorSdkCatalogError extends Schema.TaggedErrorClass<CursorSdkCatalogError>()(
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

const readCursorSdkCatalog = Effect.fn("CursorSdkCatalog.read")(function* (apiKey: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const [user, models] = await Promise.all([
        Cursor.me({ apiKey }),
        Cursor.models.list({ apiKey }),
      ]);
      return { user, models } satisfies CursorSdkCatalogSnapshot;
    },
    catch: (cause) =>
      new CursorSdkCatalogError({
        authenticationFailure: isAuthenticationFailure(cause),
        cause,
      }),
  });
});

export const CursorSdkCatalogLive = Layer.succeed(
  CursorSdkCatalog,
  CursorSdkCatalog.of({ read: readCursorSdkCatalog }),
);

export function makeCursorSdkCatalogTestLayer(
  read: CursorSdkCatalogShape["read"],
): Layer.Layer<CursorSdkCatalog> {
  return Layer.succeed(CursorSdkCatalog, CursorSdkCatalog.of({ read }));
}
