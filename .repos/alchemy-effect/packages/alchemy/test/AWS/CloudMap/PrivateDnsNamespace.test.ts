import * as AWS from "@/AWS";
import { PrivateDnsNamespace } from "@/AWS/CloudMap";
import * as Test from "@/Test/Alchemy";
import * as sd from "@distilled.cloud/aws/servicediscovery";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const findNamespace = (namespaceId: string) =>
  sd.getNamespace({ Id: namespaceId }).pipe(
    Effect.map((r) => r.Namespace),
    Effect.catchTag("NamespaceNotFound", () => Effect.succeed(undefined)),
  );

class NamespaceStillExists extends Data.TaggedError("NamespaceStillExists")<{
  readonly namespaceId: string;
}> {}

const assertNamespaceDeleted = (namespaceId: string) =>
  findNamespace(namespaceId).pipe(
    Effect.flatMap((namespace) =>
      namespace === undefined
        ? Effect.void
        : Effect.fail(new NamespaceStillExists({ namespaceId })),
    ),
    Effect.retry({
      while: (e) => e._tag === "NamespaceStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

test.provider(
  "create, update description + SOA TTL, delete private DNS namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const vpc = yield* getDefaultVpc;

      const namespace = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PrivateDnsNamespace("TestPrivateNamespace", {
            name: "alchemy-test-cloudmap-private.local",
            vpc: vpc.vpcId,
            description: "initial description",
            ttl: "60 seconds",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(namespace.namespaceId).toBeDefined();
      expect(namespace.namespaceArn).toContain(":namespace/");
      expect(namespace.namespaceName).toBe(
        "alchemy-test-cloudmap-private.local",
      );
      // a private DNS namespace creates a Route 53 private hosted zone
      expect(namespace.hostedZoneId).toBeDefined();

      // out-of-band verification via distilled
      const created = yield* findNamespace(namespace.namespaceId);
      expect(created?.Type).toBe("DNS_PRIVATE");
      expect(created?.Description).toBe("initial description");
      expect(created?.Properties?.DnsProperties?.SOA?.TTL).toBe(60);
      const tags = yield* sd
        .listTagsForResource({ ResourceARN: namespace.namespaceArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestPrivateNamespace");

      // update description + SOA TTL (async namespace update operation)
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PrivateDnsNamespace("TestPrivateNamespace", {
            name: "alchemy-test-cloudmap-private.local",
            vpc: vpc.vpcId,
            description: "updated description",
            ttl: "120 seconds",
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.namespaceId).toBe(namespace.namespaceId);

      const afterUpdate = yield* findNamespace(namespace.namespaceId);
      expect(afterUpdate?.Description).toBe("updated description");
      expect(afterUpdate?.Properties?.DnsProperties?.SOA?.TTL).toBe(120);

      yield* stack.destroy();
      yield* assertNamespaceDeleted(namespace.namespaceId);
    }),
  { timeout: 240_000 },
);
