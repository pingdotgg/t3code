import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withDataplexSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Data domains are allowlisted: the testing project gets Forbidden
// "Permission 'dataplex.dataDomains.get' denied". Set
// GCP_TEST_DATAPLEX_DATA_DOMAIN=1 on an allowlisted project.
const runLifecycle = process.env.GCP_TEST_DATAPLEX_DATA_DOMAIN === "1";

const contactsA: dataplex.GoogleCloudDataplexV1Contacts = {
  identities: [
    {
      contactName: "steward",
      contactRole: "steward",
      contactId: "steward@example.com",
    },
  ],
};

const contactsB: dataplex.GoogleCloudDataplexV1Contacts = {
  identities: [
    {
      contactName: "owner",
      contactRole: "owner",
      contactId: "owner@example.com",
    },
  ],
};

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsDataDomains({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDataDomains on a missing domain fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataplex.getProjectsLocationsDataDomains({
          name: `projects/${project}/locations/us-central1/dataDomains/alchemy-missing-domain`,
        }),
      );
      expect(error._tag).toEqual(runLifecycle ? "NotFound" : "Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a data domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.DataDomain("Finance", {
            location: "us-central1",
            displayName: "Finance",
            description: "domain a",
            labels: { env: "test" },
            contacts: contactsA,
          });
        }),
      );

      expect(created.name).toContain("/dataDomains/");
      expect(created.dataDomainId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("Finance");
      expect(created.description).toEqual("domain a");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsDataDomains({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.DataDomain("Finance", {
            dataDomainId: created.dataDomainId,
            location: "us-central1",
            displayName: "Finance prod",
            description: "domain b",
            labels: { env: "prod", team: "data" },
            contacts: contactsB,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Finance prod");
      expect(updated.description).toEqual("domain b");
      expect(updated.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
