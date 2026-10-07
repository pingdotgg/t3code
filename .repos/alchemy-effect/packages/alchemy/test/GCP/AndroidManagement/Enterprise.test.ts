import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, currentProject, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  androidmanagement.getEnterprises({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getEnterprises without the Android Management scope fails with InsufficientScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.getEnterprises({
          name: "enterprises/alchemy-missing-enterprise",
        }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidmanagement", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createEnterprises without Android Management access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      const projectId = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.createEnterprises({
          projectId,
          agreementAccepted: true,
          body: {
            enterpriseDisplayName: "Alchemy Android Management Probe",
          },
        }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidmanagement", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an enterprise",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidManagement.Enterprise("Work", {
            enterpriseDisplayName: "Alchemy Work",
          });
        }),
      );

      expect(created.name.startsWith("enterprises/")).toEqual(true);
      expect(created.enterpriseId.length).toBeGreaterThan(0);
      expect(created.enterpriseDisplayName).toEqual("Alchemy Work");

      const fetched = yield* androidmanagement.getEnterprises({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.enterpriseDisplayName).toEqual("Alchemy Work");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidManagement.Enterprise("Work", {
            enterpriseDisplayName: "Alchemy Work 2026",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.enterpriseDisplayName).toEqual("Alchemy Work 2026");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidmanagement", "live"],
    timeout: 90_000,
  },
);
