import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

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
const projectNameOf = (project: string) => `projects/${project}`;

const waitUntilGone = (name: string) =>
  logging.getOrganizationsLocationsLogScopes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsLocationsLogScopes on a missing log scope fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getOrganizationsLocationsLogScopes({
          name: `${organization}/locations/global/logScopes/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId)(
  "create, update, replace, and delete an organization logging log scope",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationLogScope("App", {
            organization,
            resourceNames: [projectNameOf(project)],
            description: "application logs",
          });
        }),
      );

      expect(created.logScopeId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(
        `${organization}/locations/global/logScopes/${created.logScopeId}`,
      );
      expect(created.resourceNames).toEqual([projectNameOf(project)]);
      expect(created.description).toEqual("application logs");

      const fetched = yield* logging.getOrganizationsLocationsLogScopes({
        name: created.name,
      });
      expect(fetched.resourceNames).toEqual([projectNameOf(project)]);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationLogScope("App", {
            organization,
            logScopeId: created.logScopeId,
            resourceNames: [projectNameOf(project)],
            description: "updated application logs",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated application logs");

      const last = created.logScopeId.at(-1) ?? "a";
      const nextId = `${created.logScopeId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationLogScope("App", {
            organization,
            logScopeId: nextId,
            resourceNames: [projectNameOf(project)],
            description: "replaced scope",
          });
        }),
      );

      expect(replaced.logScopeId).not.toEqual(created.logScopeId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
