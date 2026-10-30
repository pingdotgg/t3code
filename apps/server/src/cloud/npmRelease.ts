import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import { npmReleaseDatabaseMigration } from "@t3tools/shared/cliRelease";
import { isWindowsCommandNotFound } from "@t3tools/provider-core/server/snapshotProbe";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const Manifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)),
  t3code: Schema.optionalKey(Schema.Unknown),
});
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Manifest, Schema.Tuple([Manifest])])),
);
const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })),
);
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);
const NPM_UNAVAILABLE =
  "npm could not be started on this machine. Install npm or make it available on the server's PATH.";

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("NpmRelease.lookup")(function* (spec: string) {
      const result = yield* runner
        .run({
          command: "npm",
          args: ["view", "--global", "--json", `t3@${spec}`],
          timeout: Duration.seconds(15),
          maxOutputBytes: 256 * 1024,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ServerNpmReleaseError({
                reason:
                  error._tag === "ProcessSpawnError"
                    ? NPM_UNAVAILABLE
                    : "npm could not complete the lookup.",
              }),
          ),
        );
      if (result.timedOut || result.stdoutTruncated || result.stdoutInvalidUtf8) {
        return yield* new ServerNpmReleaseError({ reason: "npm returned an incomplete response." });
      }
      if (result.code !== 0) {
        if (yield* isWindowsCommandNotFound(result.code, result.stderr)) {
          return yield* new ServerNpmReleaseError({ reason: NPM_UNAVAILABLE });
        }
        const error = Option.getOrUndefined(decodeError(result.stdout));
        if (error?.error.code === "E404") return null;
        return yield* new ServerNpmReleaseError({ reason: "npm could not read release metadata." });
      }
      const decoded = Option.getOrUndefined(decodeManifest(result.stdout));
      const manifest = decoded && ("version" in decoded ? decoded : decoded[0]);
      if (!manifest || (spec !== "latest" && spec !== "nightly" && manifest.version !== spec)) {
        return yield* new ServerNpmReleaseError({
          reason: "npm returned invalid release metadata.",
        });
      }
      const databaseMigration = npmReleaseDatabaseMigration(manifest);
      return {
        version: manifest.version,
        ...(databaseMigration === undefined ? {} : { databaseMigration }),
      };
    }),
  });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(ProcessRunner.layer));
