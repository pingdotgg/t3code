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
const LOCATION = "us-central1";

const waitUntilGone = (name: string) =>
  eventarc.getProjectsLocationsMessageBuses({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsMessageBuses on a missing bus fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        eventarc.getProjectsLocationsMessageBuses({
          name: `projects/${project}/locations/${LOCATION}/messageBuses/alchemy-missing-bus`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Eventarc message bus",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Eventarc.MessageBus("Events", {
            location: LOCATION,
            displayName: "events",
            loggingConfig: { logSeverity: "INFO" },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/messageBuses/");
      expect(created.messageBusId).toEqual(expect.any(String));
      expect(created.location).toEqual(LOCATION);
      expect(created.displayName).toEqual("events");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* eventarc.getProjectsLocationsMessageBuses({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.displayName).toEqual("events");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Eventarc.MessageBus("Events", {
            messageBusId: created.messageBusId,
            location: LOCATION,
            displayName: "events-v2",
            loggingConfig: { logSeverity: "WARNING" },
            labels: { env: "prod", role: "bus" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.messageBusId).toEqual(created.messageBusId);
      expect(updated.displayName).toEqual("events-v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "bus" });

      const refetched = yield* eventarc.getProjectsLocationsMessageBuses({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("bus");
      expect(refetched.displayName).toEqual("events-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 120_000 },
);
