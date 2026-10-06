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
  dlp.getOrganizationsStoredInfoTypes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsStoredInfoTypes on a missing stored info type fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getOrganizationsStoredInfoTypes({
          name: `${organization}/storedInfoTypes/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId)(
  "create, update, and delete an organization stored info type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationStoredInfoType("EmployeeId", {
            organization,
            displayName: "employee ids",
            description: "badge numbers",
            regex: { pattern: "EMP[0-9]{6}" },
          });
        }),
      );

      expect(created.storedInfoTypeId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(
        `${organization}/storedInfoTypes/${created.storedInfoTypeId}`,
      );
      expect(created.displayName).toEqual("employee ids");
      expect(created.description).toEqual("badge numbers");

      const fetched = yield* dlp.getOrganizationsStoredInfoTypes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.currentVersion?.config?.description).toContain(
        "alchemy-id=",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationStoredInfoType("EmployeeId", {
            storedInfoTypeId: created.storedInfoTypeId,
            organization,
            displayName: "employee ids v2",
            description: "badge numbers v2",
            regex: { pattern: "EMP[0-9]{8}" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("employee ids v2");
      expect(updated.description).toEqual("badge numbers v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
