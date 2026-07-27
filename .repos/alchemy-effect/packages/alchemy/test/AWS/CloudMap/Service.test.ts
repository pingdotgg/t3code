import * as AWS from "@/AWS";
import { PrivateDnsNamespace, Service } from "@/AWS/CloudMap";
import * as Test from "@/Test/Alchemy";
import * as sd from "@distilled.cloud/aws/servicediscovery";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const findService = (serviceId: string) =>
  sd.getService({ Id: serviceId }).pipe(
    Effect.map((r) => r.Service),
    Effect.catchTag("ServiceNotFound", () => Effect.succeed(undefined)),
  );

class ServiceStillExists extends Data.TaggedError("ServiceStillExists")<{
  readonly serviceId: string;
}> {}

const assertServiceDeleted = (serviceId: string) =>
  findService(serviceId).pipe(
    Effect.flatMap((service) =>
      service === undefined
        ? Effect.void
        : Effect.fail(new ServiceStillExists({ serviceId })),
    ),
    Effect.retry({
      while: (e) => e._tag === "ServiceStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

test.provider(
  "DNS service lifecycle: create, update TTL + description, replace on record type change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const vpc = yield* getDefaultVpc;

      const makeStack = (
        records: { type: "A" | "SRV"; ttl: Duration.Input }[],
        description: string,
        attributes?: Record<string, string>,
      ) =>
        Effect.gen(function* () {
          const namespace = yield* PrivateDnsNamespace("ServiceTestNamespace", {
            name: "alchemy-test-cloudmap-service.local",
            vpc: vpc.vpcId,
          });
          // no pinned name: replacement must generate a fresh physical name
          // (a pinned name would collide during create-before-delete)
          const service = yield* Service("Backend", {
            namespaceId: namespace.namespaceId,
            description,
            dnsRecords: records,
            routingPolicy: "MULTIVALUE",
            attributes,
            tags: { Environment: "test" },
          });
          return { namespace, service };
        });

      const findServiceAttributes = (serviceId: string) =>
        sd
          .getServiceAttributes({ ServiceId: serviceId })
          .pipe(Effect.map((r) => r.ServiceAttributes?.Attributes ?? {}));

      const { namespace, service } = yield* stack.deploy(
        makeStack([{ type: "A", ttl: "10 seconds" }], "initial", {
          tier: "backend",
          stage: "one",
        }),
      );

      expect(service.serviceId).toBeDefined();
      expect(service.serviceArn).toContain(":service/");
      // engine-generated physical name (long test-derived prefixes truncate,
      // so only assert shape)
      expect(service.serviceName.length).toBeGreaterThan(0);
      expect(service.serviceName.length).toBeLessThanOrEqual(63);
      expect(service.namespaceId).toBe(namespace.namespaceId);
      expect(service.namespaceName).toBe("alchemy-test-cloudmap-service.local");

      // out-of-band verification via distilled
      const created = yield* findService(service.serviceId);
      expect(created?.Description).toBe("initial");
      expect(created?.DnsConfig?.RoutingPolicy).toBe("MULTIVALUE");
      expect(created?.DnsConfig?.DnsRecords).toEqual([{ Type: "A", TTL: 10 }]);
      const tags = yield* sd
        .listTagsForResource({ ResourceARN: service.serviceArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("Backend");

      // custom service attributes were written on create
      expect(yield* findServiceAttributes(service.serviceId)).toEqual({
        tier: "backend",
        stage: "one",
      });

      // TTL + description + attributes are mutable via updateService /
      // updateServiceAttributes / deleteServiceAttributes (tier changed,
      // stage removed, extra added)
      const updated = yield* stack.deploy(
        makeStack([{ type: "A", ttl: "30 seconds" }], "updated", {
          tier: "web",
          extra: "x",
        }),
      );
      expect(updated.service.serviceId).toBe(service.serviceId);

      const afterUpdate = yield* findService(service.serviceId);
      expect(afterUpdate?.Description).toBe("updated");
      expect(afterUpdate?.DnsConfig?.DnsRecords).toEqual([
        { Type: "A", TTL: 30 },
      ]);
      expect(yield* findServiceAttributes(service.serviceId)).toEqual({
        tier: "web",
        extra: "x",
      });

      // changing the record TYPE replaces the service
      const replaced = yield* stack.deploy(
        makeStack([{ type: "SRV", ttl: "30 seconds" }], "updated"),
      );
      expect(replaced.service.serviceId).not.toBe(service.serviceId);
      const afterReplace = yield* findService(replaced.service.serviceId);
      expect(afterReplace?.DnsConfig?.DnsRecords).toEqual([
        { Type: "SRV", TTL: 30 },
      ]);
      yield* assertServiceDeleted(service.serviceId);

      yield* stack.destroy();
      yield* assertServiceDeleted(replaced.service.serviceId);
    }),
  { timeout: 240_000 },
);
