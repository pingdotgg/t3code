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

const location = "global";

const hybridInspect = {
  inspectConfig: {
    infoTypes: [{ name: "EMAIL_ADDRESS" }],
    includeQuote: true,
  },
  storageConfig: { hybridOptions: { description: "hybrid scan" } },
};

const waitUntilGone = (name: string) =>
  dlp.getProjectsLocationsDlpJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDlpJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsLocationsDlpJobs({
          name: `projects/${project}/locations/${location}/dlpJobs/i-alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider(
  "create, refresh, and delete a location dlp job",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsDlpJob("Scan", {
            location,
            inspectJob: hybridInspect,
          });
        }),
      );

      expect(created.jobId.startsWith("i-")).toEqual(true);
      expect(created.location).toEqual(location);
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/dlpJobs/${created.jobId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.type).toEqual("INSPECT_JOB");
      expect(created.state).toEqual(expect.any(String));

      const fetched = yield* dlp.getProjectsLocationsDlpJobs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.type).toEqual("INSPECT_JOB");
      const hybrid =
        fetched.inspectDetails?.requestedOptions?.jobConfig?.storageConfig
          ?.hybridOptions;
      expect(
        Object.keys(hybrid?.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);
      expect(hybrid?.description).toContain("alchemy-id=");

      const refreshed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsDlpJob("Scan", {
            jobId: created.jobId,
            location,
            inspectJob: hybridInspect,
          });
        }),
      );

      expect(refreshed.name).toEqual(created.name);
      expect(refreshed.jobId).toEqual(created.jobId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
