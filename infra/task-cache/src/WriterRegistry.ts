import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const Writers = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeWriters = Schema.decodeEffect(Writers);
const encodeWriters = Schema.encodeEffect(Writers);

const stateDirectory = Config.String("HOME").pipe(
  Effect.map((home) => `${home}/.config/t3-task-cache`),
);

const Credential = Schema.fromJsonString(
  Schema.Struct({ endpoint: Schema.String, name: Schema.String, token: Schema.String }),
);
class ManagementError extends Schema.TaggedError<ManagementError>()("ManagementError", {
  message: Schema.String,
}) {}
export const isWriterName = (name: string) =>
  /^(?!writers$|credentials$|readers$|ci-reader$)[a-z0-9-]{1,64}$/.test(name);

const encodeCredential = Schema.encodeEffect(Credential);

export class WriterRegistry extends Context.Service<
  WriterRegistry,
  {
    readonly read: () => Effect.Effect<
      Record<string, string>,
      PlatformError.PlatformError | Schema.SchemaError
    >;
    readonly update: (
      name: string,
      revoke: boolean,
      endpoint?: string,
      initialize?: boolean,
    ) => Effect.Effect<
      string | undefined,
      PlatformError.PlatformError | Schema.SchemaError | ManagementError
    >;
  }
>()("@t3tools/task-cache/WriterRegistry") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const state = yield* stateDirectory;
  const readWriters = Effect.fn("TaskCache.readWriters")(function* () {
    return yield* decodeWriters(yield* fs.readFileString(`${state}/writers.json`));
  });

  const save = Effect.fn("TaskCache.save")(function* (
    entries: ReadonlyArray<readonly [string, string]>,
  ) {
    yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: state,
          prefix: ".writer-",
        });
        for (const [name, value] of entries)
          yield* fs.writeFileString(`${directory}/${name}.json`, value + "\n", { mode: 0o600 });
        // The registry is the authorization commit point and must publish last.
        for (const [name] of entries)
          yield* fs.rename(`${directory}/${name}.json`, `${state}/${name}.json`);
      }),
    );
  });

  const updateWriter = Effect.fn("TaskCache.updateWriter")(function* (
    name: string,
    revoke: boolean,
    endpoint?: string,
    initialize = false,
  ) {
    if (!isWriterName(name)) return yield* new ManagementError({ message: "Invalid writer name." });
    if (!revoke && !endpoint)
      return yield* new ManagementError({ message: "A deployed cache endpoint is required." });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });
        // Exclusive creation coordinates separate management processes as well as fibers.
        yield* Effect.acquireRelease(
          fs.makeDirectory(`${state}/writers.lock`).pipe(
            Effect.mapError((error) =>
              error.reason._tag === "AlreadyExists"
                ? new ManagementError({
                    message:
                      "Writer registry is locked by another update. Retry after it completes; remove writers.lock only if that process has stopped.",
                  })
                : error,
            ),
          ),
          () => fs.remove(`${state}/writers.lock`, { recursive: true }).pipe(Effect.orDie),
        );
        const exists = yield* fs.exists(`${state}/writers.json`);
        if (!exists && !initialize)
          return yield* new ManagementError({
            message:
              "Writer registry is missing. Copy the existing private registry from its administrator; use --new-registry only when creating a new cache.",
          });
        const writers = { ...(exists || revoke ? yield* readWriters() : {}) };
        const token = hex(yield* crypto.randomBytes(32));
        if (revoke) delete writers[name];
        else {
          writers[name] = hex(yield* crypto.digest("SHA-256", new TextEncoder().encode(token)));
        }
        const entries: Array<readonly [string, string]> = [];
        if (!revoke && endpoint)
          entries.push([name, yield* encodeCredential({ endpoint, name, token })]);
        entries.push(["writers", yield* encodeWriters(writers)]);
        yield* save(entries);
        return revoke ? undefined : `${state}/${name}.json`;
      }),
    );
  });
  return WriterRegistry.of({ read: readWriters, update: updateWriter });
});

export const layer = Layer.effect(WriterRegistry, make);

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
