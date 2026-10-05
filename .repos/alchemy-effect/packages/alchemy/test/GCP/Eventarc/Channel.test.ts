import * as GCP from "@/GCP";
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

const LOCATION = "us-central1";

const waitUntilGone = (name: string) =>
  eventarc.getProjectsLocationsChannels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an Eventarc channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Eventarc.Channel("Events", {
            location: LOCATION,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/channels/");
      expect(created.channelId).toEqual(expect.any(String));
      expect(created.location).toEqual(LOCATION);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* eventarc.getProjectsLocationsChannels({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Eventarc.Channel("Events", {
            channelId: created.channelId,
            location: LOCATION,
            labels: { env: "prod", role: "events" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.channelId).toEqual(created.channelId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "events" });

      const refetched = yield* eventarc.getProjectsLocationsChannels({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("events");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 120_000 },
);
