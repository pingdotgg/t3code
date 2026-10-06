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

// ChannelConnection is created in a third-party provider project using
// a subscriber Channel activation token. The testing project is not an
// Eventarc SaaS partner; live create is gated.
const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_EVENTARC_PARTNER === "1";
const LOCATION = "us-central1";

const waitUntilGone = (name: string) =>
  eventarc.getProjectsLocationsChannelConnections({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsChannelConnections on a missing connection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        eventarc.getProjectsLocationsChannelConnections({
          name: `projects/${project}/locations/${LOCATION}/channelConnections/alchemy-missing-connection`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Eventarc channel connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const channel = yield* GCP.Eventarc.Channel("Events", {
            location: LOCATION,
            labels: { env: "test" },
          });
          const connection = yield* GCP.Eventarc.ChannelConnection("Partner", {
            location: LOCATION,
            channel: channel.name,
            activationToken: channel.activationToken,
            labels: { env: "test" },
          });
          return { channel, connection };
        }),
      );

      expect(created.connection.name).toContain("/channelConnections/");
      expect(created.connection.channelConnectionId).toEqual(
        expect.any(String),
      );
      expect(created.connection.location).toEqual(LOCATION);
      expect(created.connection.channel).toEqual(created.channel.name);
      expect(created.connection.labels).toMatchObject({ env: "test" });

      const fetched = yield* eventarc.getProjectsLocationsChannelConnections({
        name: created.connection.name,
      });
      expect(fetched.name).toEqual(created.connection.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.channel).toEqual(created.channel.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const channel = yield* GCP.Eventarc.Channel("Events", {
            channelId: created.channel.channelId,
            location: LOCATION,
            labels: { env: "test" },
          });
          return yield* GCP.Eventarc.ChannelConnection("Partner", {
            channelConnectionId: created.connection.channelConnectionId,
            location: LOCATION,
            channel: channel.name,
            labels: { env: "prod", role: "connection" },
          });
        }),
      );

      expect(updated.channel).toEqual(created.channel.name);
      expect(updated.labels).toMatchObject({
        env: "prod",
        role: "connection",
      });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.connection.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 180_000 },
);
