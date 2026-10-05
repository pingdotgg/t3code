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

const waitUntilGone = (name: string) =>
  integrations.getProjectsLocationsAuthConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const credential = {
  credentialType: "USERNAME_AND_PASSWORD" as const,
  usernameAndPassword: { username: "alchemy", password: "test-secret" },
};

test.provider(
  "getProjectsLocationsAuthConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsAuthConfigs({
          name: `projects/${project}/locations/us-central1/authConfigs/alchemy-missing-auth`,
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

test.provider(
  "create, update, and delete an auth config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.AuthConfig("Salesforce", {
            location: "us-central1",
            displayName: "alchemy-salesforce",
            description: "basic auth",
            credentialType: "USERNAME_AND_PASSWORD",
            decryptedCredential: credential,
            visibility: "PRIVATE",
          });
        }),
      );

      expect(created.name).toContain("/authConfigs/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("alchemy-salesforce");
      expect(created.description).toEqual("basic auth");
      expect(created.credentialType).toEqual("USERNAME_AND_PASSWORD");

      const fetched = yield* integrations.getProjectsLocationsAuthConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("basic auth");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.AuthConfig("Salesforce", {
            authConfigId: created.authConfigId,
            location: "us-central1",
            displayName: "alchemy-salesforce",
            description: "updated auth",
            credentialType: "USERNAME_AND_PASSWORD",
            decryptedCredential: credential,
            visibility: "PRIVATE",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated auth");

      const fetchedUpdate = yield* integrations.getProjectsLocationsAuthConfigs(
        {
          name: updated.name,
        },
      );
      expect(fetchedUpdate.description).toContain("updated auth");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);
