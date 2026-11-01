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

const waitUntilGone = (name: string) =>
  dlp.getOrganizationsInspectTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsInspectTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getOrganizationsInspectTemplates({
          name: `${organization}/inspectTemplates/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId)(
  "create, update, and delete an organization inspect template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsInspectTemplate("Emails", {
            organization,
            displayName: "emails",
            description: "detect emails",
            inspectConfig: {
              infoTypes: [{ name: "EMAIL_ADDRESS" }],
              includeQuote: true,
            },
          });
        }),
      );

      expect(created.templateId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `${organization}/inspectTemplates/${created.templateId}`,
      );
      expect(created.description).toEqual("detect emails");

      const fetched = yield* dlp.getOrganizationsInspectTemplates({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.inspectConfig?.includeQuote).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsInspectTemplate("Emails", {
            organization,
            templateId: created.templateId,
            displayName: "emails-v2",
            description: "detect emails and phones",
            inspectConfig: {
              infoTypes: [{ name: "EMAIL_ADDRESS" }, { name: "PHONE_NUMBER" }],
              includeQuote: false,
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("emails-v2");
      expect(updated.description).toEqual("detect emails and phones");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
