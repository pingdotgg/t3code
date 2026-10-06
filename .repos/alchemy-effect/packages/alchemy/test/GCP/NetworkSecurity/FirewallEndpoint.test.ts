import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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

// Firewall endpoints (Cloud NGFW Enterprise) bill hourly and take well over 5
// minutes to provision; set GCP_TEST_NGFW=1 together with GCP_TEST_SLOW to run.
const runLifecycle =
  !!process.env.GCP_TEST_NGFW &&
  !!process.env.GCP_TEST_SLOW &&
  !process.env.FAST;

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsFirewallEndpoints({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsFirewallEndpoints on a missing endpoint fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsFirewallEndpoints({
          name: `projects/${project}/locations/us-central1-a/firewallEndpoints/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a firewall endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.FirewallEndpoint("Ngfw", {
            location: "us-central1-a",
            description: "firewall endpoint a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/firewallEndpoints/");
      expect(created.firewallEndpointId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1-a");
      expect(created.description).toEqual("firewall endpoint a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networksecurity.getProjectsLocationsFirewallEndpoints({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("firewall endpoint a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.FirewallEndpoint("Ngfw", {
            firewallEndpointId: created.firewallEndpointId,
            location: "us-central1-a",
            description: "firewall endpoint b",
            labels: { env: "prod", role: "ngfw" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("firewall endpoint b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ngfw" });

      const refetched =
        yield* networksecurity.getProjectsLocationsFirewallEndpoints({
          name: created.name,
        });
      expect(refetched.description).toEqual("firewall endpoint b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("ngfw");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
