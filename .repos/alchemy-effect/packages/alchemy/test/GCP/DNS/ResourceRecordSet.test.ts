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

const waitUntilGone = (
  project: string,
  managedZone: string,
  name: string,
  type: string,
) =>
  dns
    .getResourceRecordSets({
      project,
      managedZone,
      name,
      type,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "create, update, replace, and delete a resource record set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* GCP.DNS.ManagedZone("Public", {
            description: "alchemy rrset test zone",
            labels: { env: "test" },
            forceDestroy: true,
          });
          const record = yield* GCP.DNS.ResourceRecordSet("Www", {
            managedZone: zone.zoneName,
            name: "www",
            type: "A",
            ttl: 300,
            rrdatas: ["203.0.113.10"],
          });
          return { zone, record };
        }),
      );

      const recordName = `www.${created.zone.dnsName}`;
      expect(created.record.managedZone).toEqual(created.zone.zoneName);
      expect(created.record.name).toEqual(recordName);
      expect(created.record.type).toEqual("A");
      expect(created.record.ttl).toEqual(300);
      expect(created.record.rrdatas).toEqual(["203.0.113.10"]);
      expect(created.record.project).toEqual(created.zone.project);

      const fetched = yield* dns.getResourceRecordSets({
        project: created.record.project,
        managedZone: created.zone.zoneName,
        name: recordName,
        type: "A",
      });
      expect(fetched.name).toEqual(recordName);
      expect(fetched.type).toEqual("A");
      expect(fetched.ttl).toEqual(300);
      expect(fetched.rrdatas).toEqual(["203.0.113.10"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* GCP.DNS.ManagedZone("Public", {
            zoneName: created.zone.zoneName,
            dnsName: created.zone.dnsName,
            description: "alchemy rrset test zone",
            labels: { env: "test" },
            forceDestroy: true,
          });
          const record = yield* GCP.DNS.ResourceRecordSet("Www", {
            managedZone: zone.zoneName,
            name: "www",
            type: "A",
            ttl: 600,
            rrdatas: ["203.0.113.20", "203.0.113.21"],
          });
          return { zone, record };
        }),
      );

      expect(updated.record.name).toEqual(recordName);
      expect(updated.record.type).toEqual("A");
      expect(updated.record.ttl).toEqual(600);
      expect(updated.record.rrdatas).toEqual(["203.0.113.20", "203.0.113.21"]);

      const fetchedUpdated = yield* dns.getResourceRecordSets({
        project: created.record.project,
        managedZone: created.zone.zoneName,
        name: recordName,
        type: "A",
      });
      expect(fetchedUpdated.ttl).toEqual(600);
      expect(fetchedUpdated.rrdatas).toEqual(["203.0.113.20", "203.0.113.21"]);

      const replacedName = `api.${created.zone.dnsName}`;
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* GCP.DNS.ManagedZone("Public", {
            zoneName: created.zone.zoneName,
            dnsName: created.zone.dnsName,
            description: "alchemy rrset test zone",
            labels: { env: "test" },
            forceDestroy: true,
          });
          const record = yield* GCP.DNS.ResourceRecordSet("Www", {
            managedZone: zone.zoneName,
            name: "api",
            type: "A",
            ttl: 120,
            rrdatas: ["203.0.113.30"],
          });
          return { zone, record };
        }),
      );

      expect(replaced.record.name).toEqual(replacedName);
      expect(replaced.record.ttl).toEqual(120);
      expect(replaced.record.rrdatas).toEqual(["203.0.113.30"]);

      const fetchedReplaced = yield* dns.getResourceRecordSets({
        project: created.record.project,
        managedZone: created.zone.zoneName,
        name: replacedName,
        type: "A",
      });
      expect(fetchedReplaced.rrdatas).toEqual(["203.0.113.30"]);

      const previousGone = yield* waitUntilGone(
        created.record.project,
        created.zone.zoneName,
        recordName,
        "A",
      );
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.record.project,
        created.zone.zoneName,
        replacedName,
        "A",
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dns", "live"], timeout: 90_000 },
);
