import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const SERVICE_ACCOUNT_EMAIL =
  "alchemy-testing@alchemy-gcp-testing-83661.iam.gserviceaccount.com";

const waitUntilGone = (projectId: string, accessId: string) =>
  storage.getProjectsHmacKeys({ projectId, accessId }).pipe(
    Effect.map((metadata) =>
      metadata.state?.toUpperCase() === "DELETED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an HMAC key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.HmacKey("Interop", {
            serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
          });
        }),
      );

      expect(created.accessId).toEqual(expect.any(String));
      expect(created.accessId.length).toBeGreaterThan(0);
      expect(created.serviceAccountEmail).toEqual(SERVICE_ACCOUNT_EMAIL);
      expect(created.state).toEqual("ACTIVE");
      expect(created.projectId).toEqual(expect.any(String));
      expect(Redacted.isRedacted(created.secret)).toEqual(true);

      const fetched = yield* storage.getProjectsHmacKeys({
        projectId: created.projectId,
        accessId: created.accessId,
      });
      expect(fetched.accessId).toEqual(created.accessId);
      expect(fetched.state).toEqual("ACTIVE");
      expect(fetched.serviceAccountEmail).toEqual(SERVICE_ACCOUNT_EMAIL);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.HmacKey("Interop", {
            serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
            state: "INACTIVE",
          });
        }),
      );

      expect(updated.accessId).toEqual(created.accessId);
      expect(updated.state).toEqual("INACTIVE");
      expect(Redacted.isRedacted(updated.secret)).toEqual(true);

      const refetched = yield* storage.getProjectsHmacKeys({
        projectId: updated.projectId,
        accessId: updated.accessId,
      });
      expect(refetched.accessId).toEqual(created.accessId);
      expect(refetched.state).toEqual("INACTIVE");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.projectId, created.accessId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 90_000 },
);
