import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { enterpriseName, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  androidmanagement.getEnterprisesEnrollmentTokens({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getEnterprisesEnrollmentTokens without the Android Management scope fails with InsufficientScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.getEnterprisesEnrollmentTokens({
          name: "enterprises/alchemy-missing-enterprise/enrollmentTokens/alchemy-missing",
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
  "createEnterprisesEnrollmentTokens without Android Management access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidmanagement.createEnterprisesEnrollmentTokens({
          parent: "enterprises/alchemy-missing-enterprise",
          body: {
            duration: "3600s",
            additionalData: "alchemy-probe",
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
  "create, update, and delete an enrollment token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const enterprise = enterpriseName
            ? { name: enterpriseName }
            : yield* GCP.AndroidManagement.Enterprise("TokenHost", {
                enterpriseDisplayName: "Token Host",
              });
          const token = yield* GCP.AndroidManagement.EnterprisesEnrollmentToken(
            "Enroll",
            {
              parent: enterprise.name,
              duration: "86400s",
              additionalData: "org-unit-a",
            },
          );
          return { enterprise, token };
        }),
      );

      expect(created.token.name).toContain("/enrollmentTokens/");
      expect(created.token.parent).toEqual(created.enterprise.name);
      expect(created.token.enrollmentTokenId.length).toBeGreaterThan(0);
      expect(created.token.value).toEqual(expect.any(String));

      const fetched = yield* androidmanagement.getEnterprisesEnrollmentTokens({
        name: created.token.name,
      });
      expect(fetched.name).toEqual(created.token.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const enterprise = enterpriseName
            ? { name: enterpriseName }
            : yield* GCP.AndroidManagement.Enterprise("TokenHost", {
                enterpriseDisplayName: "Token Host",
              });
          return yield* GCP.AndroidManagement.EnterprisesEnrollmentToken(
            "Enroll",
            {
              parent: enterprise.name,
              duration: "172800s",
              additionalData: "org-unit-b",
            },
          );
        }),
      );

      expect(updated.name).not.toEqual(created.token.name);
      expect(updated.parent).toEqual(created.enterprise.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidmanagement", "live"],
    timeout: 90_000,
  },
);
