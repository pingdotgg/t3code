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

const location = "us-central1";

const hybridInspect = (infoTypes: string[]) => ({
  inspectConfig: {
    infoTypes: infoTypes.map((name) => ({ name })),
    includeQuote: true,
  },
  storageConfig: { hybridOptions: { description: "hybrid inbox" } },
});

const waitUntilGone = (name: string) =>
  dlp.getProjectsLocationsJobTriggers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsJobTriggers on a missing trigger fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsLocationsJobTriggers({
          name: `projects/${project}/locations/${location}/jobTriggers/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a location job trigger",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsJobTrigger("Inbox", {
            location,
            displayName: "inbox scan",
            description: "paused hybrid inspect",
            status: "PAUSED",
            inspectJob: hybridInspect(["EMAIL_ADDRESS"]),
            triggers: [{ manual: {} }],
          });
        }),
      );

      expect(created.triggerId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/jobTriggers/${created.triggerId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.displayName).toEqual("inbox scan");
      expect(created.description).toEqual("paused hybrid inspect");
      expect(created.status).toEqual("PAUSED");

      const fetched = yield* dlp.getProjectsLocationsJobTriggers({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("paused hybrid inspect");
      expect(fetched.status).toEqual("PAUSED");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsJobTrigger("Inbox", {
            triggerId: created.triggerId,
            location,
            displayName: "inbox scan v2",
            description: "paused hybrid inspect v2",
            status: "PAUSED",
            inspectJob: hybridInspect(["EMAIL_ADDRESS", "PHONE_NUMBER"]),
            triggers: [{ manual: {} }],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("inbox scan v2");
      expect(updated.description).toEqual("paused hybrid inspect v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
