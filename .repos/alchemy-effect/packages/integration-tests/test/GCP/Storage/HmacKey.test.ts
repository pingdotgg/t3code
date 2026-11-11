import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

// A just-created HMAC key can read back as 404 "Access ID not found" briefly.
const getKey = (projectId: string, accessId: string) =>
  storage.getProjectsHmacKeys({ projectId, accessId }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
  );

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The testing profile's own service account, derived from the configured project.
const serviceAccountEmailOf = GcpEnvironment.current.pipe(
  Effect.map(({ project }) => `alchemy-testing@${project}.iam.gserviceaccount.com`),
);

const waitUntilGone = (projectId: string, accessId: string) =>
  storage.getProjectsHmacKeys({ projectId, accessId }).pipe(
    Effect.map((metadata) =>
      metadata.state?.toUpperCase() === "DELETED" ? ("gone" as const) : ("found" as const),
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
      const serviceAccountEmail = yield* serviceAccountEmailOf;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.HmacKey("Interop", {
            serviceAccountEmail,
          });
        }),
      );

      expect(created.accessId).toEqual(expect.any(String));
      expect(created.accessId.length).toBeGreaterThan(0);
      expect(created.serviceAccountEmail).toEqual(serviceAccountEmail);
      expect(created.state).toEqual("ACTIVE");
      expect(created.projectId).toEqual(expect.any(String));
      expect(Redacted.isRedacted(created.secret)).toEqual(true);

      const fetched = yield* getKey(created.projectId, created.accessId);
      expect(fetched.accessId).toEqual(created.accessId);
      expect(fetched.state).toEqual("ACTIVE");
      expect(fetched.serviceAccountEmail).toEqual(serviceAccountEmail);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.HmacKey("Interop", {
            serviceAccountEmail,
            state: "INACTIVE",
          });
        }),
      );

      expect(updated.accessId).toEqual(created.accessId);
      expect(updated.state).toEqual("INACTIVE");
      expect(Redacted.isRedacted(updated.secret)).toEqual(true);

      const refetched = yield* getKey(updated.projectId, updated.accessId);
      expect(refetched.accessId).toEqual(created.accessId);
      expect(refetched.state).toEqual("INACTIVE");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.projectId, created.accessId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 90_000 },
);
