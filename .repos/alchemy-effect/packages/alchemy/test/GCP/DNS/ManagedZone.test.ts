import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/gcp/dns_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, zoneName: string) =>
  dns.getManagedZones({ project, managedZone: zoneName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a managed zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DNS.ManagedZone("Public", {
            description: "alchemy test zone",
            labels: { env: "test" },
            forceDestroy: true,
          });
        }),
      );

      expect(created.zoneName).toEqual(expect.any(String));
      expect(created.dnsName).toEqual(`${created.zoneName}.alchemy-gcp-test.`);
      expect(created.visibility).toEqual("public");
      expect(created.description).toEqual("alchemy test zone");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.enableLogging).toEqual(false);
      expect(created.nameServers.length).toBeGreaterThan(0);

      const fetched = yield* dns.getManagedZones({
        project: created.project,
        managedZone: created.zoneName,
      });
      expect(fetched.name).toEqual(created.zoneName);
      expect(fetched.dnsName).toEqual(created.dnsName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("alchemy test zone");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DNS.ManagedZone("Public", {
            zoneName: created.zoneName,
            dnsName: created.dnsName,
            description: "updated alchemy test zone",
            labels: { env: "prod", role: "dns" },
            enableLogging: true,
            forceDestroy: true,
          });
        }),
      );

      expect(updated.zoneName).toEqual(created.zoneName);
      expect(updated.dnsName).toEqual(created.dnsName);
      expect(updated.description).toEqual("updated alchemy test zone");
      expect(updated.labels).toMatchObject({ env: "prod", role: "dns" });
      expect(updated.enableLogging).toEqual(true);

      const fetchedUpdate = yield* dns.getManagedZones({
        project: created.project,
        managedZone: created.zoneName,
      });
      expect(fetchedUpdate.description).toEqual("updated alchemy test zone");
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("dns");
      expect(fetchedUpdate.cloudLoggingConfig?.enableLogging).toEqual(true);

      const replacedDnsName = `${created.zoneName}.alchemy-gcp-replaced.`;
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DNS.ManagedZone("Public", {
            zoneName: created.zoneName,
            dnsName: replacedDnsName,
            description: "replaced alchemy test zone",
            labels: { env: "prod" },
            forceDestroy: true,
          });
        }),
      );

      expect(replaced.zoneName).toEqual(created.zoneName);
      expect(replaced.dnsName).toEqual(replacedDnsName);
      expect(replaced.description).toEqual("replaced alchemy test zone");

      const fetchedReplacement = yield* dns.getManagedZones({
        project: created.project,
        managedZone: created.zoneName,
      });
      expect(fetchedReplacement.dnsName).toEqual(replacedDnsName);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.zoneName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dns", "live"], timeout: 90_000 },
);
