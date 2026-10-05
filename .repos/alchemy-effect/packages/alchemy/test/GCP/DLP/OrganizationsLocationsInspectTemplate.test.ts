import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

// Organization-scoped: set GOOGLE_ORGANIZATION_ID when the credentials
// administer the organization (the testing service account does not).
const organizationId = process.env.GOOGLE_ORGANIZATION_ID?.trim().replace(
  /^organizations\//,
  "",
);
const organization = `organizations/${organizationId}`;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const location = "us-central1";

const waitUntilGone = (name: string) =>
  dlp.getOrganizationsLocationsInspectTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsLocationsInspectTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getOrganizationsLocationsInspectTemplates({
          name: `${organization}/locations/${location}/inspectTemplates/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId)(
  "create, update, and delete a location-scoped organization inspect template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = `${organization}/locations/${location}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsLocationsInspectTemplate(
            "Phones",
            {
              organization,
              location,
              displayName: "phones",
              description: "detect phones",
              inspectConfig: {
                infoTypes: [{ name: "PHONE_NUMBER" }],
                includeQuote: true,
              },
            },
          );
        }),
      );

      expect(created.location).toEqual(location);
      expect(created.name).toEqual(
        `${parent}/inspectTemplates/${created.templateId}`,
      );

      const fetched = yield* dlp.getOrganizationsLocationsInspectTemplates({
        name: created.name,
      });
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsLocationsInspectTemplate(
            "Phones",
            {
              organization,
              location,
              templateId: created.templateId,
              displayName: "phones-v2",
              description: "detect phones v2",
              inspectConfig: {
                infoTypes: [{ name: "PHONE_NUMBER" }],
                includeQuote: false,
              },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("phones-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
