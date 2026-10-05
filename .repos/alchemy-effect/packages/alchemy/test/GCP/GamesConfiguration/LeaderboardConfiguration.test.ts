import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gamesConfiguration from "@distilled.cloud/gcp/gamesConfiguration_v1configuration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  applicationId,
  logLevel,
  missingTag,
  probeApplicationId,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (leaderboardId: string) =>
  gamesConfiguration.getLeaderboardConfigurations({ leaderboardId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getLeaderboardConfigurations on a missing leaderboard fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gamesConfiguration.getLeaderboardConfigurations({
          leaderboardId: "alchemy-missing-leaderboard",
        }),
      );
      expect(error._tag).toEqual(missingTag);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gamesconfiguration", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!applicationId)(
  "insertLeaderboardConfigurations without Play Games access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gamesConfiguration.insertLeaderboardConfigurations({
          applicationId: probeApplicationId,
          body: {
            scoreOrder: "LARGER_IS_BETTER",
            draft: {
              name: {
                translations: [{ locale: "en-US", value: "Alchemy Probe" }],
              },
              scoreFormat: { numberFormatType: "NUMERIC", numDecimalPlaces: 0 },
            },
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gamesconfiguration", "live"],
    timeout: 90_000,
  },
);

// Needs a Play Games Services application the credentials administer; without
// one the API rejects inserts with Forbidden (probe above).
// Set GCP_GAMESCONFIGURATION_APPLICATION_ID to run the lifecycle.
test.provider.skipIf(!applicationId)(
  "create, update, and delete a leaderboard configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GamesConfiguration.LeaderboardConfiguration(
            "HighScore",
            {
              applicationId: applicationId!,
              name: "High Score",
              scoreOrder: "LARGER_IS_BETTER",
            },
          );
        }),
      );

      expect(created.leaderboardId.length).toBeGreaterThan(0);
      expect(created.applicationId).toEqual(applicationId);
      expect(created.name).toEqual("High Score");

      const fetched = yield* gamesConfiguration.getLeaderboardConfigurations({
        leaderboardId: created.leaderboardId,
      });
      expect(fetched.id).toEqual(created.leaderboardId);
      expect(fetched.draft?.name?.translations?.[0]?.value).toEqual(
        "High Score",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GamesConfiguration.LeaderboardConfiguration(
            "HighScore",
            {
              applicationId: created.applicationId,
              leaderboardId: created.leaderboardId,
              name: "All-time High Score",
              scoreOrder: "LARGER_IS_BETTER",
            },
          );
        }),
      );

      expect(updated.leaderboardId).toEqual(created.leaderboardId);
      expect(updated.name).toEqual("All-time High Score");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.leaderboardId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gamesconfiguration", "live"],
    timeout: 90_000,
  },
);
