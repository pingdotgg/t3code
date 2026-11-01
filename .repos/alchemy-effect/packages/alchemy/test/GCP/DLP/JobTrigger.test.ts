import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const inspectJob = (description: string) => ({
  inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
  storageConfig: { hybridOptions: { description } },
});

const waitUntilGone = (name: string) =>
  dlp.getProjectsJobTriggers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsJobTriggers on a missing trigger fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsJobTriggers({
          name: `projects/${project}/jobTriggers/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a paused job trigger",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.JobTrigger("Nightly", {
            displayName: "nightly hybrid",
            description: "paused inspect",
            status: "PAUSED",
            inspectJob: inspectJob("hybrid"),
            triggers: [{ manual: {} }],
          });
        }),
      );

      expect(created.triggerId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/jobTriggers/${created.triggerId}`,
      );
      expect(created.status).toEqual("PAUSED");
      expect(created.displayName).toEqual("nightly hybrid");
      expect(created.description).toEqual("paused inspect");

      const fetched = yield* dlp.getProjectsJobTriggers({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.status).toEqual("PAUSED");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.JobTrigger("Nightly", {
            triggerId: created.triggerId,
            displayName: "nightly hybrid v2",
            description: "paused inspect v2",
            status: "PAUSED",
            inspectJob: inspectJob("hybrid v2"),
            triggers: [{ manual: {} }],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("nightly hybrid v2");
      expect(updated.description).toEqual("paused inspect v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
