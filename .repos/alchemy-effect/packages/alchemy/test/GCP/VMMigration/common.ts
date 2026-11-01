import { GcpEnvironment } from "@/GCP/Environment";
import type { GcpOpError } from "@distilled.cloud/gcp/vmmigration_v1";
import { Forbidden, NotFound } from "@distilled.cloud/gcp/vmmigration_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// An AWS source only finishes creating once Migrate to VMs can reach AWS with
// the credentials: with placeholder keys the create operation never completes
// (the source stays in state PENDING). Set GCP_TEST_VMMIGRATION_AWS_ACCESS_KEY_ID
// and GCP_TEST_VMMIGRATION_AWS_SECRET_ACCESS_KEY to run the source lifecycles.
const awsAccessKeyId = process.env.GCP_TEST_VMMIGRATION_AWS_ACCESS_KEY_ID;
const awsSecretAccessKey =
  process.env.GCP_TEST_VMMIGRATION_AWS_SECRET_ACCESS_KEY;

export const runSourceLifecycle = !!awsAccessKeyId && !!awsSecretAccessKey;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const dummyAws = {
  awsRegion: "us-east-1",
  accessKeyCreds: {
    accessKeyId: awsAccessKeyId ?? "AKIATESTALCHEMY0000",
    secretAccessKey: awsSecretAccessKey ?? "alchemy-test-secret",
  },
} as const;

export const waitUntilGone = <A, R>(
  get: Effect.Effect<A, NotFound | Forbidden | GcpOpError, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
