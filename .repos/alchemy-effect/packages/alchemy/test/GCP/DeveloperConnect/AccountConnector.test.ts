import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
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
  developerconnect.getProjectsLocationsAccountConnectors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAccountConnectors on a missing connector fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.getProjectsLocationsAccountConnectors({
          name: `projects/${project}/locations/us-central1/accountConnectors/alchemy-missing-connector`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, replace, and delete an account connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeveloperConnect.AccountConnector("Github", {
            location: "us-central1",
            providerOauthConfig: {
              systemProviderId: "GITHUB",
              scopes: ["repo"],
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.accountConnectorId).toEqual(expect.any(String));
      expect(created.name).toContain("/accountConnectors/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.providerOauthConfig?.systemProviderId).toEqual("GITHUB");

      const fetched =
        yield* developerconnect.getProjectsLocationsAccountConnectors({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.providerOauthConfig?.systemProviderId).toEqual("GITHUB");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeveloperConnect.AccountConnector("Github", {
            accountConnectorId: created.accountConnectorId,
            location: "us-central1",
            providerOauthConfig: {
              systemProviderId: "GITHUB",
              scopes: ["repo"],
            },
            labels: { env: "prod", role: "scm" },
            proxyConfig: { enabled: true },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "scm" });
      expect(updated.proxyConfig?.enabled).toEqual(true);

      const fetchedUpdate =
        yield* developerconnect.getProjectsLocationsAccountConnectors({
          name: updated.name,
        });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("scm");
      expect(fetchedUpdate.proxyConfig?.enabled).toEqual(true);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeveloperConnect.AccountConnector("Github", {
            accountConnectorId: created.accountConnectorId,
            location: "us-east1",
            providerOauthConfig: {
              systemProviderId: "GITHUB",
              scopes: ["repo"],
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(replaced.accountConnectorId).toEqual(created.accountConnectorId);
      expect(replaced.location).toEqual("us-east1");
      expect(replaced.name).toContain("/locations/us-east1/");
      expect(replaced.name).not.toEqual(created.name);

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
    timeout: 90_000,
  },
);
