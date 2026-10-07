import { encodeFqn } from "@/FQN";
import { localState } from "@/State/LocalState";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/** Only nonsecret row identity and lifecycle fields leave the filesystem barrier. */
export const ResourceRow = Schema.Struct({
  resourceType: Schema.String,
  fqn: Schema.String,
  instanceId: Schema.String,
  status: Schema.String,
  attr: Schema.optional(
    Schema.Struct({
      appName: Schema.String,
      machineId: Schema.String,
      machineIds: Schema.Array(Schema.String),
      rolloutPending: Schema.optional(Schema.Boolean),
    }),
  ),
});

type ResourceRow = typeof ResourceRow.Type;

/** Delay one final resource-row rename; all filesystem operations remain real. */
export const delayedResourceWrite = (target: {
  stack: string;
  stage: string;
  fqn: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const held = yield* Deferred.make<ResourceRow>();
    const released = yield* Deferred.make<void>();
    const written = yield* Deferred.make<ResourceRow>();
    const suffix = path.join(
      ".alchemy",
      "state",
      target.stack,
      target.stage,
      `${encodeFqn(target.fqn)}.json`,
    );
    let intercepted = false;
    const forwarded: FileSystem.FileSystem = {
      ...fs,
      rename: (from, to) =>
        Effect.gen(function* () {
          if (
            !intercepted &&
            to.endsWith(`${path.sep}${suffix}`) &&
            from.startsWith(`${to}.`) &&
            from.endsWith(".tmp")
          ) {
            const row = yield* fs.readFileString(from).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.fromJsonString(ResourceRow)),
              ),
              Effect.catchTag("SchemaError", () =>
                Effect.fail(
                  PlatformError.badArgument({
                    module: "FileSystem",
                    method: "rename",
                    description: "Invalid delayed resource-row identity",
                  }),
                ),
              ),
            );
            if (
              row.resourceType === "Fly.Machine" &&
              row.fqn === target.fqn &&
              row.status === "updated" &&
              row.attr !== undefined
            ) {
              yield* Effect.sync(() => {
                intercepted = true;
              });
              yield* Deferred.succeed(held, row);
              yield* Deferred.await(released).pipe(
                Effect.timeout("600 seconds"),
                Effect.catchTag("TimeoutError", () =>
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: "TimedOut",
                      module: "FileSystem",
                      method: "rename",
                      description:
                        "Delayed resource-row release exceeded 600 seconds",
                    }),
                  ),
                ),
              );
              yield* fs.rename(from, to);
              yield* Deferred.succeed(written, row);
              return;
            }
          }
          yield* fs.rename(from, to);
        }),
    };
    return {
      state: localState().pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, forwarded)),
      ),
      wait: Deferred.await(held).pipe(Effect.timeout("600 seconds")),
      release: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
      written: Deferred.await(written).pipe(Effect.timeout("600 seconds")),
    };
  });
