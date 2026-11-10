import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import { npmReleaseDatabaseMigration } from "@t3tools/shared/cliRelease";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";

const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/));
const Manifest = Schema.Struct({ version: Version, t3code: Schema.optionalKey(Schema.Unknown) });
// npm prints a bare version string when the release has no `t3code` field.
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Manifest, Schema.Tuple([Manifest]), Version])),
);
const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })),
);
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

function toRelease(spec: string, json: string) {
  const decoded = Option.getOrUndefined(decodeManifest(json));
  const manifest =
    typeof decoded === "string"
      ? { version: decoded }
      : decoded && ("version" in decoded ? decoded : decoded[0]);
  if (!manifest || (spec !== "latest" && spec !== "nightly" && manifest.version !== spec)) {
    return Effect.fail(
      new ServerNpmReleaseError({ reason: "npm returned invalid release metadata." }),
    );
  }
  const databaseMigration = npmReleaseDatabaseMigration(manifest);
  return Effect.succeed({
    version: manifest.version,
    ...(databaseMigration === undefined ? {} : { databaseMigration }),
  });
}

export const make = Effect.fn("NpmRelease.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient;
  const lookupPublic = Effect.fn("NpmRelease.lookupPublic")(function* (spec: string) {
    const unreachable = new ServerNpmReleaseError({
      reason: "npm is not installed and the public npm registry could not be reached.",
    });
    const json = yield* Effect.gen(function* () {
      const response = yield* http.get(`https://registry.npmjs.org/t3/${spec}`);
      if (response.status === 404) return Option.none<string>();
      if (response.status < 200 || response.status >= 300) return yield* unreachable;
      return Option.some(yield* response.text);
    }).pipe(
      Effect.timeout(Duration.seconds(15)),
      Effect.mapError(() => unreachable),
    );
    return Option.isNone(json) ? null : yield* toRelease(spec, json.value);
  });
  // npm loads the whole package history per lookup, so a burst of specs must not spawn one each.
  const npmPermits = yield* Semaphore.make(2);
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("NpmRelease.lookup")(function* (spec: string) {
      // Without npm there is no configured registry to honor, so use the public one.
      const npmPath = yield* resolveCommandPath("npm");
      if (npmPath === null) return yield* lookupPublic(spec);
      const output = yield* npmPermits
        .withPermits(1)(
          runner.run({
            command: npmPath,
            // Named fields keep the output small; the full package document grows with every release.
            args: ["view", "--global", "--json", `t3@${spec}`, "version", "t3code"],
            timeout: Duration.seconds(15),
            maxOutputBytes: 256 * 1024,
          }),
        )
        .pipe(
          Effect.tapError((error) =>
            Effect.logInfo("npm release lookup failed", { tag: error._tag }),
          ),
          Effect.mapError(
            () => new ServerNpmReleaseError({ reason: "npm could not complete the lookup." }),
          ),
        );
      if (output.timedOut || output.stdoutTruncated || output.stdoutInvalidUtf8) {
        return yield* new ServerNpmReleaseError({ reason: "npm returned an incomplete response." });
      }
      if (output.code !== 0) {
        const error = Option.getOrUndefined(decodeError(output.stdout));
        if (error?.error.code === "E404") return null;
        yield* Effect.logInfo("npm release lookup failed", {
          exitCode: output.code,
          npmErrorCode: error?.error.code,
        });
        return yield* new ServerNpmReleaseError({ reason: "npm could not read release metadata." });
      }
      return yield* toRelease(spec, output.stdout);
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

export const layer = Layer.effect(NpmRelease, make()).pipe(
  Layer.provide([ProcessRunner.layer, FetchHttpClient.layer]),
);
