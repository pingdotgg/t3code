import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as agentidentity from "@distilled.cloud/gcp/agentidentity_v1";
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

// The Agent Identity API is not enabled in the testing project. Set
// GCP_TEST_AGENT_IDENTITY=1 on a project where it is.
const entitled = !!process.env.GCP_TEST_AGENT_IDENTITY;

const waitUntilGone = (name: string) =>
  agentidentity.getProjectsLocationsAuthProviders({ name }).pipe(
    Effect.map((item) =>
      item.deleted === true ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!entitled)(
  "getProjectsLocationsAuthProviders on a missing provider fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        agentidentity.getProjectsLocationsAuthProviders({
          name: `projects/${project}/locations/${location}/authProviders/alchemy-missing-auth`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:agentidentity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(entitled)(
  "getProjectsLocationsAuthProviders fails with ServiceDisabled while the API is disabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        agentidentity.getProjectsLocationsAuthProviders({
          name: `projects/${project}/locations/${location}/authProviders/alchemy-missing-auth`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:agentidentity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!entitled)(
  "create, update, and delete an Agent Identity auth provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AgentIdentity.AuthProvider("Maps", {
            location,
            description: "alchemy maps key",
            labels: { env: "test" },
            allowedScopes: ["https://www.googleapis.com/auth/cloud-platform"],
            authProviderTypeParams: {
              apiKey: { apiKey: "alchemy-test-api-key" },
            },
          });
        }),
      );

      expect(created.name).toContain("/authProviders/");
      expect(created.authProviderId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.description).toEqual("alchemy maps key");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.disabled).toEqual(false);
      expect(created.authProviderTypeParams?.apiKey).toBeDefined();

      const fetched = yield* agentidentity.getProjectsLocationsAuthProviders({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("alchemy maps key");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AgentIdentity.AuthProvider("Maps", {
            authProviderId: created.authProviderId,
            location,
            description: "alchemy maps key v2",
            labels: { env: "prod", role: "maps" },
            allowedScopes: [
              "https://www.googleapis.com/auth/cloud-platform",
              "https://www.googleapis.com/auth/userinfo.email",
            ],
            authProviderTypeParams: {
              apiKey: { apiKey: "alchemy-test-api-key" },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.authProviderId).toEqual(created.authProviderId);
      expect(updated.description).toEqual("alchemy maps key v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "maps" });

      const fetchedUpdate =
        yield* agentidentity.getProjectsLocationsAuthProviders({
          name: created.name,
        });
      expect(fetchedUpdate.description).toEqual("alchemy maps key v2");
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("maps");
      expect(fetchedUpdate.labels?.["alchemy-id"]).toEqual(expect.any(String));

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:agentidentity", "live"],
    timeout: 90_000,
  },
);
