import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { PackageName } from "./Manifest.ts";

/**
 * The HTTP contract between the `pkg` CLI and the registry Worker, as an
 * `HttpApi`. The Worker implements it with `HttpApiBuilder`; the CLI calls
 * it through `HttpApiClient`. Importing this file pulls in no runtime code.
 */

/**
 * The GitHub Actions run a request comes from. It is a lookup hint, not a
 * credential: the registry resolves the run through the GitHub API and
 * trusts only what GitHub says about it.
 */
export const RunRef = Schema.Struct({
  repo: Schema.String,
  runId: Schema.Number,
  attempt: Schema.Number,
});
export type RunRef = typeof RunRef.Type;

/**
 * Name of the artifact a job uploads to its own run to vouch for a manifest.
 * Only the job holds the runtime token that can add artifacts to the run, so
 * an artifact carrying the manifest's hash is GitHub's record that this run
 * approved exactly these package hashes.
 */
export const manifestArtifactName = (sha256: string) =>
  `pkg-manifest-${sha256}`;

/** Lowercase hex SHA-256. */
export const Sha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
);

export const TarballRef = Schema.Struct({
  name: PackageName,
  sha256: Sha256,
});
export type TarballRef = typeof TarballRef.Type;

/** The request names no usable run, or carries an invalid body. */
export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The repository may not publish, or the run has not vouched for the manifest. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Requests come from inside a run, so a finished run cannot publish. */
export class RunNotInProgress extends Schema.TaggedError<RunNotInProgress>()(
  "RunNotInProgress",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Upload these, then publish again. */
export class MissingTarballs extends Schema.TaggedError<MissingTarballs>()(
  "MissingTarballs",
  { missing: Schema.Array(TarballRef) },
  { httpApiStatus: 409 },
) {}

export class PackageTooLarge extends Schema.TaggedError<PackageTooLarge>()(
  "PackageTooLarge",
  { message: Schema.String },
  { httpApiStatus: 413 },
) {}

/** GitHub could not be reached or answered with an error. */
export class Upstream extends Schema.TaggedError<Upstream>()(
  "Upstream",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

export const PublishedPackage = Schema.Struct({
  name: Schema.String,
  group: Schema.String,
  /** Install URL pinned to the commit. */
  url: Schema.String,
  tags: Schema.Array(Schema.String),
});
export type PublishedPackage = typeof PublishedPackage.Type;

export const PublishResponse = Schema.Struct({
  packages: Schema.Array(PublishedPackage),
});
export type PublishResponse = typeof PublishResponse.Type;

/**
 * `manifest` is the exact `pkg-manifest.json` text the job vouched for; its
 * SHA-256 must match an artifact on the run. Idempotent: the registry
 * either fails with {@link MissingTarballs} or writes the tags.
 */
export const publish = HttpApiEndpoint.post("publish", "/api/publish", {
  payload: Schema.Struct({ run: RunRef, manifest: Schema.String }),
  success: PublishResponse,
  error: [
    BadRequest,
    Forbidden,
    RunNotInProgress,
    MissingTarballs,
    PackageTooLarge,
    Upstream,
  ],
});

export const TarballResponse = Schema.Struct({
  name: Schema.String,
  sha256: Sha256,
  size: Schema.Number,
  uploaded: Schema.Boolean,
});
export type TarballResponse = typeof TarballResponse.Type;

/**
 * Content-addressed upload. Any in-progress run of an allowed repository
 * may upload; bytes only become reachable once a vouched manifest tags
 * them. The run travels in the query because the body is the tarball.
 */
export const uploadTarball = HttpApiEndpoint.put(
  "uploadTarball",
  "/api/tarballs/:name/:sha256",
  {
    params: TarballRef,
    query: RunRef,
    payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    success: TarballResponse,
    error: [BadRequest, Forbidden, RunNotInProgress, PackageTooLarge, Upstream],
  },
);

export const health = HttpApiEndpoint.get("health", "/api/health", {
  success: Schema.Struct({ ok: Schema.Boolean }),
});

export class Registry extends HttpApiGroup.make("Registry")
  .add(publish)
  .add(uploadTarball) {}

export class Health extends HttpApiGroup.make("Health").add(health) {}

export class PkgApi extends HttpApi.make("Pkg").add(Registry).add(Health) {}

/**
 * Immutable tarball URL on the registry. Dependencies between packed
 * packages link to these, so a tarball's bytes depend only on its own
 * source and its dependencies' bytes, never on a commit, and identical
 * builds deduplicate across commits, pull requests, and repositories.
 */
export const tarballUrl = (registry: string, name: string, sha256: string) =>
  `${registry.replace(/\/+$/, "")}/${name}/-/${sha256}.tgz`;
