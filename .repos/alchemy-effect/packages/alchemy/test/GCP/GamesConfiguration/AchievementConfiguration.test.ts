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

const waitUntilGone = (achievementId: string) =>
  gamesConfiguration.getAchievementConfigurations({ achievementId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getAchievementConfigurations on a missing achievement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gamesConfiguration.getAchievementConfigurations({
          achievementId: "alchemy-missing-achievement",
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
  "insertAchievementConfigurations without Play Games access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gamesConfiguration.insertAchievementConfigurations({
          applicationId: probeApplicationId,
          body: {
            achievementType: "STANDARD",
            initialState: "REVEALED",
            draft: {
              name: {
                translations: [{ locale: "en-US", value: "Alchemy Probe" }],
              },
              description: {
                translations: [{ locale: "en-US", value: "probe" }],
              },
              pointValue: 5,
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
  "create, update, and delete an achievement configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GamesConfiguration.AchievementConfiguration(
            "FirstWin",
            {
              applicationId: applicationId!,
              name: "First Win",
              description: "Win your first match",
            },
          );
        }),
      );

      expect(created.achievementId.length).toBeGreaterThan(0);
      expect(created.applicationId).toEqual(applicationId);
      expect(created.name).toEqual("First Win");
      expect(created.description).toEqual("Win your first match");

      const fetched = yield* gamesConfiguration.getAchievementConfigurations({
        achievementId: created.achievementId,
      });
      expect(fetched.id).toEqual(created.achievementId);
      expect(fetched.draft?.description?.translations?.[0]?.value).toEqual(
        "Win your first match",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GamesConfiguration.AchievementConfiguration(
            "FirstWin",
            {
              applicationId: created.applicationId,
              achievementId: created.achievementId,
              name: "First Win",
              description: "Win a match",
            },
          );
        }),
      );

      expect(updated.achievementId).toEqual(created.achievementId);
      expect(updated.description).toEqual("Win a match");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.achievementId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gamesconfiguration", "live"],
    timeout: 90_000,
  },
);
