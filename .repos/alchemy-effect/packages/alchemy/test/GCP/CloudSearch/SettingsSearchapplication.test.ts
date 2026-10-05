import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudsearch from "@distilled.cloud/gcp/cloudsearch_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  cloudsearch.getSettingsSearchapplications({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getSettingsSearchapplications on a missing application fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudsearch.getSettingsSearchapplications({
          name: "searchapplications/alchemy-missing-search-app",
        }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudsearch", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createSettingsSearchapplications without Cloud Search admin fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudsearch.createSettingsSearchapplications({
          body: {
            displayName: "Alchemy Cloud Search App Probe",
          },
        }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudsearch", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a search application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudSearch.SettingsSearchapplication("Intranet", {
            displayName: "Intranet",
            enableAuditLog: true,
          });
        }),
      );

      expect(created.name.startsWith("searchapplications/")).toEqual(true);
      expect(created.searchApplicationId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("Intranet");
      expect(created.enableAuditLog).toEqual(true);

      const fetched = yield* cloudsearch.getSettingsSearchapplications({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual(created.displayName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudSearch.SettingsSearchapplication("Intranet", {
            searchApplicationId: created.searchApplicationId,
            displayName: "Company search",
            enableAuditLog: true,
            returnResultThumbnailUrls: true,
          });
        }),
      );

      expect(updated.searchApplicationId).toEqual(created.searchApplicationId);
      expect(updated.displayName).toEqual("Company search");
      expect(updated.returnResultThumbnailUrls).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudsearch", "live"],
    timeout: 90_000,
  },
);
