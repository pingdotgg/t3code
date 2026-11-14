import * as NodeModule from "node:module";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class CheckoutCloneError extends Schema.TaggedError<CheckoutCloneError>()(
  "CheckoutCloneError",
  {
    source: Schema.String,
    destination: Schema.String,
    errno: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not clone ${this.source} to ${this.destination}${this.errno === undefined ? "" : ` (errno ${this.errno})`}.`;
  }
}

/**
 * Copies a file or a whole folder copy-on-write in one call, sharing data blocks until either
 * copy changes. The destination must not exist. Undefined where the platform has no such call.
 */
export const CheckoutCloner = Context.Reference<
  ((source: string, destination: string) => Effect.Effect<void, CheckoutCloneError>) | undefined
>("t3/vcs/CheckoutCloner", { defaultValue: () => undefined });

// A single-executable server resolves packages on disk only through `require`.
const requireForFfi = NodeModule.createRequire(import.meta.url);

/** macOS `clonefile(2)`, which clones a folder hierarchy in the kernel; elsewhere nothing. */
export const layer = Layer.effect(
  CheckoutCloner,
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return undefined;
    const loadClonefile = yield* Effect.cached(
      Effect.try({
        try: () => {
          const { DataType, load, open } = requireForFfi("ffi-rs") as typeof import("ffi-rs");
          open({ library: "t3-libsystem", path: "/usr/lib/libSystem.B.dylib" });
          return (source: string, destination: string) =>
            load({
              library: "t3-libsystem",
              funcName: "clonefile",
              retType: DataType.I32,
              paramsType: [DataType.String, DataType.String, DataType.I32],
              // CLONE_NOFOLLOW: clone a symlink itself rather than its target.
              paramsValue: [source, destination, 0x0001],
              errno: true,
              // A large folder takes hundreds of milliseconds; keep it off the event loop.
              runInNewThread: true,
            });
        },
        catch: (cause) =>
          new CheckoutCloneError({ source: "ffi-rs", destination: "clonefile", cause }),
      }),
    );
    return Effect.fn("CheckoutCloner.clonefile")(function* (source: string, destination: string) {
      const clonefile = yield* loadClonefile.pipe(
        Effect.mapError(
          (error) => new CheckoutCloneError({ source, destination, cause: error.cause }),
        ),
      );
      const result = yield* Effect.tryPromise({
        try: () => clonefile(source, destination),
        catch: (cause) => new CheckoutCloneError({ source, destination, cause }),
      });
      // ffi-rs types the errno form as a union with the plain return value.
      if (typeof result === "number" || result.value !== 0) {
        return yield* new CheckoutCloneError({
          source,
          destination,
          ...(typeof result === "number" ? {} : { errno: result.errnoCode }),
        });
      }
    });
  }),
);
