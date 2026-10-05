import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
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
  logging.getOrganizationsLocationsSavedQueries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsLocationsSavedQueries on a missing query fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getOrganizationsLocationsSavedQueries({
          name: `${organization}/locations/global/savedQueries/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId)(
  "create, update, replace, and delete an organization logging saved query",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationSavedQuery("Errors", {
            organization,
            displayName: "organization errors",
            loggingQuery: { filter: "severity>=ERROR" },
            description: "error query",
          });
        }),
      );

      expect(created.savedQueryId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(
        `${organization}/locations/global/savedQueries/${created.savedQueryId}`,
      );
      expect(created.displayName).toEqual("organization errors");
      expect(created.loggingQuery?.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("error query");

      const fetched = yield* logging.getOrganizationsLocationsSavedQueries({
        name: created.name,
      });
      expect(fetched.displayName).toEqual("organization errors");
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationSavedQuery("Errors", {
            organization,
            savedQueryId: created.savedQueryId,
            displayName: "organization warnings",
            loggingQuery: { filter: "severity>=WARNING" },
            description: "warning query",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("organization warnings");
      expect(updated.loggingQuery?.filter).toEqual("severity>=WARNING");

      const last = created.savedQueryId.at(-1) ?? "a";
      const nextId = `${created.savedQueryId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationSavedQuery("Errors", {
            organization,
            savedQueryId: nextId,
            displayName: "replaced query",
            loggingQuery: { filter: "severity>=ERROR" },
            description: "replaced query",
          });
        }),
      );

      expect(replaced.savedQueryId).not.toEqual(created.savedQueryId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
