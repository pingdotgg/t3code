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

const inspect = (infoTypes: string[]) => ({
  infoTypes: infoTypes.map((name) => ({ name })),
  includeQuote: true,
});

const waitUntilGone = (name: string) =>
  dlp.getProjectsLocationsInspectTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsInspectTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsLocationsInspectTemplates({
          name: `projects/${project}/locations/${location}/inspectTemplates/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, replace, and delete a location inspect template",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsInspectTemplate("Emails", {
            location,
            displayName: "emails",
            description: "find email addresses",
            inspectConfig: inspect(["EMAIL_ADDRESS"]),
          });
        }),
      );

      expect(created.templateId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/inspectTemplates/${created.templateId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.displayName).toEqual("emails");
      expect(created.description).toEqual("find email addresses");
      expect(created.allowLimitedAvailabilityInfoTypes).toEqual(false);

      const fetched = yield* dlp.getProjectsLocationsInspectTemplates({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("find email addresses");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsInspectTemplate("Emails", {
            templateId: created.templateId,
            location,
            displayName: "emails and phones",
            description: "find emails and phones",
            inspectConfig: inspect(["EMAIL_ADDRESS", "PHONE_NUMBER"]),
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("emails and phones");
      expect(updated.description).toEqual("find emails and phones");

      const last = created.templateId.at(-1) ?? "a";
      const nextId = `${created.templateId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsInspectTemplate("Emails", {
            templateId: nextId,
            location,
            displayName: "replaced",
            inspectConfig: inspect(["EMAIL_ADDRESS"]),
          });
        }),
      );

      expect(replaced.templateId).not.toEqual(created.templateId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
