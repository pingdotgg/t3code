import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

/**
 * Shared helpers for the `GCP.Website.*` live tests. Each test deploys a
 * framework fixture (reused from `test/AWS/Website/fixtures` or the
 * Cloudflare website fixtures), GETs the Cloud Run URL, then destroys and
 * verifies out-of-band that the service and its image repository are gone.
 */

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

export const awsFixture = (name: string) =>
  pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures", name);

export const cloudflareFixture = (name: string) =>
  pathe.resolve(import.meta.dirname, "../../Cloudflare/Website", name);

/** Live-test options: image build + push + Cloud Run rollout + destroy. */
export const liveOptions = (timeout = 900_000) => ({
  timeout,
  retry: 0,
  tags: ["provider:gcp", "provider:gcp:website", "live"],
});

/** The deployed service identity a test needs to verify teardown. */
export interface DeployedService {
  readonly name: string;
  readonly serviceId: string;
  readonly project: string;
  readonly location: string;
}

export const cloudRunUrl = /^https:\/\/[a-z0-9-]+.*\.run\.app\/?$/;

const serviceStatus = (name: string) =>
  cloudrun.getProjectsLocationsServices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

const repositoryStatus = (name: string) =>
  artifactregistry.getProjectsLocationsRepositories({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** Out-of-band: the Cloud Run service and its `{serviceId}-src` image repository are gone. */
export const assertSiteGone = (service: DeployedService) =>
  Effect.gen(function* () {
    const service_ = yield* serviceStatus(service.name).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 15,
      }),
    );
    expect(service_).toEqual("gone");
    const repositoryId = `${service.serviceId}-src`
      .slice(0, 49)
      .replace(/-+$/g, "");
    const repository = yield* repositoryStatus(
      `projects/${service.project}/locations/${service.location}/repositories/${repositoryId}`,
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 15,
      }),
    );
    expect(repository).toEqual("gone");
  });

/** Project the deployed `GCP.Run.Service` attributes a test verifies. */
export const serviceIdentity = (service: {
  name: string;
  serviceId: string;
  project: string;
  location: string;
}): DeployedService => ({
  name: service.name,
  serviceId: service.serviceId,
  project: service.project,
  location: service.location,
});
