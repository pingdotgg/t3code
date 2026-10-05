import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;
const LOCATION = "us-east4";

const waitUntilGone = (name: string) =>
  eventarc.getProjectsLocationsGoogleApiSources({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsGoogleApiSources on a missing source fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        eventarc.getProjectsLocationsGoogleApiSources({
          name: `projects/${project}/locations/${LOCATION}/googleApiSources/alchemy-missing-source`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Eventarc Google API source",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bus = yield* GCP.Eventarc.MessageBus("Events", {
            location: LOCATION,
            labels: { env: "test" },
          });
          const source = yield* GCP.Eventarc.GoogleApiSource("GoogleEvents", {
            location: LOCATION,
            destination: bus.name,
            displayName: "google events",
            labels: { env: "test" },
          });
          return { bus, source };
        }),
      );

      expect(created.source.name).toContain("/googleApiSources/");
      expect(created.source.googleApiSourceId).toEqual(expect.any(String));
      expect(created.source.location).toEqual(LOCATION);
      expect(created.source.destination).toEqual(created.bus.name);
      expect(created.source.labels).toMatchObject({ env: "test" });

      const fetched = yield* eventarc.getProjectsLocationsGoogleApiSources({
        name: created.source.name,
      });
      expect(fetched.name).toEqual(created.source.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.destination).toEqual(created.bus.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bus = yield* GCP.Eventarc.MessageBus("Events", {
            messageBusId: created.bus.messageBusId,
            location: LOCATION,
            labels: { env: "test" },
          });
          return yield* GCP.Eventarc.GoogleApiSource("GoogleEvents", {
            googleApiSourceId: created.source.googleApiSourceId,
            location: LOCATION,
            destination: bus.name,
            displayName: "google events v2",
            loggingConfig: { logSeverity: "INFO" },
            labels: { env: "prod", role: "source" },
          });
        }),
      );

      expect(updated.name).toEqual(created.source.name);
      expect(updated.googleApiSourceId).toEqual(
        created.source.googleApiSourceId,
      );
      expect(updated.displayName).toEqual("google events v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "source" });

      const refetched = yield* eventarc.getProjectsLocationsGoogleApiSources({
        name: created.source.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("source");
      expect(refetched.displayName).toEqual("google events v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.source.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 180_000 },
);
