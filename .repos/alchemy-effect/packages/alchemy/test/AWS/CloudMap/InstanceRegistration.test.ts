import * as AWS from "@/AWS";
import { HttpNamespace, InstanceRegistration, Service } from "@/AWS/CloudMap";
import * as Test from "@/Test/Alchemy";
import * as sd from "@distilled.cloud/aws/servicediscovery";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findInstance = (serviceId: string, instanceId: string) =>
  sd.getInstance({ ServiceId: serviceId, InstanceId: instanceId }).pipe(
    Effect.map((r) => r.Instance),
    Effect.catchTag(["InstanceNotFound", "ServiceNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

class InstanceStillExists extends Data.TaggedError("InstanceStillExists")<{
  readonly instanceId: string;
}> {}

const assertInstanceDeleted = (serviceId: string, instanceId: string) =>
  findInstance(serviceId, instanceId).pipe(
    Effect.flatMap((instance) =>
      instance === undefined
        ? Effect.void
        : Effect.fail(new InstanceStillExists({ instanceId })),
    ),
    Effect.retry({
      while: (e) => e._tag === "InstanceStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

test.provider(
  "register two instances, update attributes, destroy chain (instances -> service -> namespace)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (alphaEndpoint: string) =>
        Effect.gen(function* () {
          const namespace = yield* HttpNamespace("InstanceTestNamespace", {
            name: "alchemy-test-cloudmap-instances",
          });
          const service = yield* Service("Workers", {
            namespaceId: namespace.namespaceId,
            name: "workers",
          });
          const alpha = yield* InstanceRegistration("Alpha", {
            serviceId: service.serviceId,
            instanceId: "alpha",
            attributes: { endpoint: alphaEndpoint, zone: "us-west-2a" },
          });
          const beta = yield* InstanceRegistration("Beta", {
            serviceId: service.serviceId,
            instanceId: "beta",
            attributes: { endpoint: "http://beta.internal:8080" },
          });
          return { namespace, service, alpha, beta };
        });

      const { namespace, service, alpha, beta } = yield* stack.deploy(
        makeStack("http://alpha.internal:8080"),
      );

      expect(alpha.instanceId).toBe("alpha");
      expect(beta.instanceId).toBe("beta");
      expect(alpha.serviceId).toBe(service.serviceId);

      // out-of-band verification via distilled
      const alphaInstance = yield* findInstance(service.serviceId, "alpha");
      expect(alphaInstance?.Attributes?.endpoint).toBe(
        "http://alpha.internal:8080",
      );
      expect(alphaInstance?.Attributes?.zone).toBe("us-west-2a");
      const betaInstance = yield* findInstance(service.serviceId, "beta");
      expect(betaInstance?.Attributes?.endpoint).toBe(
        "http://beta.internal:8080",
      );

      // both instances are discoverable via the data-plane API
      const discovered = yield* sd.discoverInstances({
        NamespaceName: "alchemy-test-cloudmap-instances",
        ServiceName: "workers",
        HealthStatus: "ALL",
      });
      const discoveredIds = (discovered.Instances ?? [])
        .map((i) => i.InstanceId)
        .sort();
      expect(discoveredIds).toEqual(["alpha", "beta"]);

      // attribute update re-registers (upsert) with the same identity
      const updated = yield* stack.deploy(
        makeStack("http://alpha.internal:9090"),
      );
      expect(updated.alpha.serviceId).toBe(service.serviceId);
      expect(updated.alpha.instanceId).toBe("alpha");

      const afterUpdate = yield* findInstance(service.serviceId, "alpha");
      expect(afterUpdate?.Attributes?.endpoint).toBe(
        "http://alpha.internal:9090",
      );

      // destroy tears down instances -> service -> namespace in order
      yield* stack.destroy();
      yield* assertInstanceDeleted(service.serviceId, "alpha");
      yield* assertInstanceDeleted(service.serviceId, "beta");
      const serviceGone = yield* sd.getService({ Id: service.serviceId }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ServiceNotFound", () => Effect.succeed(true)),
      );
      expect(serviceGone).toBe(true);
      const namespaceGone = yield* sd
        .getNamespace({ Id: namespace.namespaceId })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
        );
      expect(namespaceGone).toBe(true);
    }),
  { timeout: 240_000 },
);
