import { AuthError } from "@/Auth/AuthProvider.ts";
import { CredentialsStore, CredentialsStoreLive } from "@/Auth/Credentials.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

const failingDeleteLayer = CredentialsStoreLive.pipe(
  Layer.provide(
    FileSystem.layerNoop({
      remove: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: path,
          }),
        ),
    }),
  ),
);

const TestCredentials = Schema.Struct({
  type: Schema.Literal("apiKey"),
  apiKey: Schema.String,
});

it.effect(
  "fails read with a reconfigure hint when the stored shape is wrong",
  () =>
    Effect.gen(function* () {
      const store = yield* CredentialsStore;
      const error = yield* store
        .read("test", "provider", TestCredentials)
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(AuthError);
      expect(error.message).toContain("do not match the expected shape");
      expect(error.message).toContain("--reconfigure");
    }).pipe(
      Effect.provide(
        CredentialsStoreLive.pipe(
          Layer.provide(
            FileSystem.layerNoop({
              // valid JSON, but not the declared credential shape
              readFileString: () =>
                Effect.succeed(JSON.stringify({ token: "not-the-shape" })),
            }),
          ),
        ),
      ),
    ),
);

it.effect("surfaces provider credential deletion failures", () =>
  Effect.gen(function* () {
    const store = yield* CredentialsStore;
    const error = yield* store.delete("test", "provider").pipe(Effect.flip);

    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).toContain("Could not delete credentials at");
  }).pipe(Effect.provide(failingDeleteLayer)),
);

it.effect("surfaces profile credential deletion failures", () =>
  Effect.gen(function* () {
    const store = yield* CredentialsStore;
    const error = yield* store.deleteProfile("test").pipe(Effect.flip);

    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).toBe(
      "Could not delete credentials for profile 'test'.",
    );
  }).pipe(Effect.provide(failingDeleteLayer)),
);

it.effect("ignores missing credential files", () =>
  Effect.gen(function* () {
    const store = yield* CredentialsStore;
    yield* store.delete("test", "provider");
    yield* store.deleteProfile("test");
  }).pipe(
    Effect.provide(
      CredentialsStoreLive.pipe(
        Layer.provide(
          FileSystem.layerNoop({
            remove: (path) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: path,
                }),
              ),
          }),
        ),
      ),
    ),
  ),
);
