import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
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

// Updating a Salesforce instance that points at a placeholder org fails with
// InternalServerError ("Unknown Error."); set
// GCP_TEST_INTEGRATIONS_SFDC=1 when the test org ids resolve to a real
// Salesforce org.
const runSfdcLifecycle = !!process.env.GCP_TEST_INTEGRATIONS_SFDC;

// Salesforce instances must reference at least one auth config ("Auth config
// is not present in the request" otherwise).
const sfdcCredential = {
  credentialType: "USERNAME_AND_PASSWORD" as const,
  usernameAndPassword: { username: "alchemy", password: "test-secret" },
};

const waitUntilGone = (name: string) =>
  integrations.getProjectsLocationsSfdcInstances({ name }).pipe(
    Effect.map((row) =>
      (row.deleteTime ?? "").length > 0
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSfdcInstances on a missing instance fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsSfdcInstances({
          name: `projects/${project}/locations/${location}/sfdcInstances/alchemy-missing-sfdc`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runSfdcLifecycle)(
  "create, update, and delete an SFDC instance",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const auth = yield* GCP.Integrations.AuthConfig("SalesforceAuth", {
            location,
            decryptedCredential: sfdcCredential,
          });
          return yield* GCP.Integrations.SfdcInstance("Salesforce", {
            authConfigId: [auth.authConfigId],
            location,
            displayName: "alchemy-sfdc",
            description: "production salesforce",
            sfdcOrgId: "00Dxx0000000001",
          });
        }),
      );

      expect(created.sfdcInstanceId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/sfdcInstances/${created.sfdcInstanceId}`,
      );
      expect(created.displayName).toEqual("alchemy-sfdc");
      expect(created.description).toEqual("production salesforce");
      expect(created.sfdcOrgId).toEqual("00Dxx0000000001");

      const fetched = yield* integrations.getProjectsLocationsSfdcInstances({
        name: created.name,
      });
      // The API echoes names keyed by project number.
      expect(fetched.name?.split("/").slice(2)).toEqual(
        created.name.split("/").slice(2),
      );
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.sfdcOrgId).toEqual("00Dxx0000000001");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const auth = yield* GCP.Integrations.AuthConfig("SalesforceAuth", {
            location,
            decryptedCredential: sfdcCredential,
          });
          return yield* GCP.Integrations.SfdcInstance("Salesforce", {
            authConfigId: [auth.authConfigId],
            sfdcInstanceId: created.sfdcInstanceId,
            location,
            displayName: "alchemy-sfdc-v2",
            description: "production salesforce v2",
            sfdcOrgId: "00Dxx0000000002",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-sfdc-v2");
      expect(updated.description).toEqual("production salesforce v2");
      expect(updated.sfdcOrgId).toEqual("00Dxx0000000002");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);
