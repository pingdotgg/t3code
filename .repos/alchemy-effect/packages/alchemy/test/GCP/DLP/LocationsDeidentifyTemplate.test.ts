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

const redact = (infoTypes: string[]) => ({
  infoTypeTransformations: {
    transformations: [
      {
        infoTypes: infoTypes.map((name) => ({ name })),
        primitiveTransformation: { replaceWithInfoTypeConfig: {} },
      },
    ],
  },
});

const waitUntilGone = (name: string) =>
  dlp.getProjectsLocationsDeidentifyTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDeidentifyTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsLocationsDeidentifyTemplates({
          name: `projects/${project}/locations/global/deidentifyTemplates/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a location deidentify template",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsDeidentifyTemplate("Emails", {
            location: "global",
            displayName: "redact emails",
            description: "replace email findings",
            deidentifyConfig: redact(["EMAIL_ADDRESS"]),
          });
        }),
      );

      expect(created.templateId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.name).toEqual(
        `projects/${project}/locations/global/deidentifyTemplates/${created.templateId}`,
      );
      expect(created.displayName).toEqual("redact emails");
      expect(created.description).toEqual("replace email findings");

      const fetched = yield* dlp.getProjectsLocationsDeidentifyTemplates({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsDeidentifyTemplate("Emails", {
            templateId: created.templateId,
            location: "global",
            displayName: "redact emails and phones",
            description: "replace email and phone findings",
            deidentifyConfig: redact(["EMAIL_ADDRESS", "PHONE_NUMBER"]),
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("redact emails and phones");
      expect(updated.description).toEqual("replace email and phone findings");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
