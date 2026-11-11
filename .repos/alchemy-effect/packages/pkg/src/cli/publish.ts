import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { MANIFEST_FILE, ManifestJson, type Manifest } from "../Manifest.ts";
import { PkgApi, type TarballRef } from "../Protocol.ts";

export class PublishError extends Data.TaggedError("PublishError")<{
  readonly message: string;
}> {}

export interface PublishOptions {
  readonly cwd: string;
  readonly dir: string;
  readonly registry: string;
}

/**
 * The GitHub Actions run this job belongs to, from the runner's environment.
 */
const currentRun = Effect.gen(function* () {
  const repo = yield* Config.String("GITHUB_REPOSITORY");
  const runId = yield* Config.Int("GITHUB_RUN_ID");
  const attempt = yield* Config.Int("GITHUB_RUN_ATTEMPT").pipe(Config.withDefault(1));
  return { repo, runId, attempt };
}).pipe(
  Effect.mapError(
    () =>
      new PublishError({
        message: "pkg publish must run inside a GitHub Actions job",
      }),
  ),
);

/** Render a registry or transport failure as a `PublishError`. */
const failed = (what: string) => (e: { readonly _tag: string; readonly message?: string }) =>
  new PublishError({
    message: `${what}: ${e.message ? `${e._tag}: ${e.message}` : e._tag}`,
  });

/**
 * GitHub reports a run as queued, or as its previous attempt, for a few
 * seconds after a job starts, and for minutes while Actions is degraded.
 * The registry answers `RunNotInProgress` until GitHub catches up, so a
 * request from inside the job waits that out, for up to three minutes.
 */
const whileRunCatchesUp = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((e) =>
      e._tag === "RunNotInProgress"
        ? Effect.logInfo("GitHub does not report this run as in progress yet; retrying")
        : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "RunNotInProgress",
      schedule: Schedule.spaced("5 seconds"),
      times: 36,
    }),
  );

/**
 * Publish a `pkg pack` directory from the current GitHub Actions job. The
 * workflow must first have uploaded the manifest as an artifact of the run
 * under the name `pkg pack` printed; the registry verifies that artifact
 * through GitHub, then either reports the tarballs it lacks, which are
 * uploaded before trying again, or writes the tags.
 */
export const publish = Effect.fn("publish")(function* (options: PublishOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = options.registry.replace(/\/+$/, "");
  const run = yield* currentRun;
  const client = yield* HttpApiClient.make(PkgApi, { baseUrl: registry });

  const dir = path.resolve(options.cwd, options.dir);
  const manifestText = yield* fs.readFileString(path.join(dir, MANIFEST_FILE));
  const manifest = yield* Schema.decodeEffect(ManifestJson)(manifestText);
  if (manifest.registry !== registry) {
    return yield* new PublishError({
      message: `artifact was packed for ${manifest.registry}, not ${registry}`,
    });
  }

  if (manifest.packages.length === 0) {
    yield* Effect.logInfo("No affected packages to publish.");
    return { packages: [] };
  }

  const upload = (pkg: Manifest["packages"][number]) =>
    Effect.gen(function* () {
      const bytes = yield* fs.readFile(path.join(dir, pkg.file));
      const result = yield* whileRunCatchesUp(
        client.Registry.uploadTarball({
          params: { name: pkg.name, sha256: pkg.sha256 },
          query: run,
          payload: bytes,
        }),
      ).pipe(Effect.mapError(failed(`upload ${pkg.name}`)));
      yield* Effect.logInfo(
        `${result.uploaded ? "Uploaded" : "Reused"} ${pkg.name} (${pkg.sha256.slice(0, 12)}, ${pkg.size} bytes)`,
      );
    });

  const uploadMissing = (missing: ReadonlyArray<TarballRef>) => {
    const wanted = new Set(missing.map((ref) => `${ref.name}@${ref.sha256}`));
    return Effect.logInfo(
      `${missing.length} of ${manifest.packages.length} tarball(s) to upload`,
    ).pipe(
      Effect.andThen(
        Effect.forEach(
          manifest.packages.filter((pkg) => wanted.has(`${pkg.name}@${pkg.sha256}`)),
          upload,
          { concurrency: 4, discard: true },
        ),
      ),
    );
  };

  const attempt = whileRunCatchesUp(
    client.Registry.publish({
      payload: { run, manifest: manifestText },
    }),
  );
  const published = yield* attempt.pipe(
    // The first answer is usually the tarballs to upload; publish once more
    // after uploading them.
    Effect.catchTag("MissingTarballs", (e) => Effect.andThen(uploadMissing(e.missing), attempt)),
    Effect.catchTag(
      "MissingTarballs",
      (e) =>
        new PublishError({
          message: `registry still reports missing tarballs after upload: ${e.missing.map((ref) => ref.name).join(", ")}`,
        }),
    ),
    Effect.mapError((e) => (e._tag === "PublishError" ? e : failed("publish")(e))),
  );

  for (const pkg of published.packages) {
    yield* Effect.logInfo(`${pkg.name}: ${pkg.url}  [${pkg.tags.join(", ")}]`);
  }
  return published;
});
