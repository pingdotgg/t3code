import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidpublisher from "@distilled.cloud/gcp/androidpublisher_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  logLevel,
  packageName,
  probePackageName,
  missingTag,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (appId: string, editId: string) =>
  androidpublisher.getEdits({ packageName: appId, editId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getEdits on a missing edit fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidpublisher.getEdits({
          packageName: probePackageName,
          editId: "alchemy-missing-edit",
        }),
      );
      expect(error._tag).toEqual(missingTag);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "insertEdits without Play access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidpublisher.insertEdits({
          packageName: probePackageName,
          body: {},
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an app edit",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidPublisher.Edit("Release", {
            packageName: packageName!,
          });
        }),
      );

      expect(created.editId.length).toBeGreaterThan(0);
      expect(created.packageName).toEqual(packageName);

      const fetched = yield* androidpublisher.getEdits({
        packageName: created.packageName,
        editId: created.editId,
      });
      expect(fetched.id).toEqual(created.editId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.packageName, created.editId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);
