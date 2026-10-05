import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  networkservices.getProjectsLocationsAuthzExtensions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAuthzExtensions on a missing extension fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsAuthzExtensions({
          name: `projects/${project}/locations/us-central1/authzExtensions/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an authz extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const health = yield* GCP.Compute.RegionHealthCheck("AuthzHc", {
            region: "us-central1",
            type: "HTTP",
            httpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.RegionBackendService("AuthzBe", {
            region: "us-central1",
            protocol: "HTTP2",
            loadBalancingScheme: "INTERNAL_MANAGED",
            healthChecks: [health.selfLink.as<string>()],
          });
          return yield* GCP.NetworkServices.AuthzExtension("Authz", {
            location: "us-central1",
            description: "authz extension a",
            labels: { env: "test" },
            service: backend.selfLink.as<string>(),
            authority: "authz.example.com",
            timeout: "0.1s",
            loadBalancingScheme: "INTERNAL_MANAGED",
          });
        }),
      );

      expect(created.name).toContain("/authzExtensions/");
      expect(created.authzExtensionId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.authority).toEqual("authz.example.com");
      expect(created.description).toEqual("authz extension a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkservices.getProjectsLocationsAuthzExtensions({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("authz extension a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const health = yield* GCP.Compute.RegionHealthCheck("AuthzHc", {
            region: "us-central1",
            type: "HTTP",
            httpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.RegionBackendService("AuthzBe", {
            region: "us-central1",
            protocol: "HTTP2",
            loadBalancingScheme: "INTERNAL_MANAGED",
            healthChecks: [health.selfLink.as<string>()],
          });
          return yield* GCP.NetworkServices.AuthzExtension("Authz", {
            authzExtensionId: created.authzExtensionId,
            location: "us-central1",
            description: "authz extension b",
            labels: { env: "prod", role: "authz" },
            service: backend.selfLink.as<string>(),
            authority: "authz.example.com",
            timeout: "0.2s",
            failOpen: true,
            loadBalancingScheme: "INTERNAL_MANAGED",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("authz extension b");
      expect(updated.failOpen).toEqual(true);
      expect(updated.labels).toMatchObject({ env: "prod", role: "authz" });

      const refetched =
        yield* networkservices.getProjectsLocationsAuthzExtensions({
          name: created.name,
        });
      expect(refetched.description).toEqual("authz extension b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.failOpen).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 180_000,
  },
);
