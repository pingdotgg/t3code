import * as AWS from "@/AWS";
import { IPSet } from "@/AWS/WAFv2";
import * as Test from "@/Test/Alchemy";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class IPSetStillExists extends Data.TaggedError("IPSetStillExists")<{
  readonly name: string;
}> {}

const assertIpSetDeleted = (name: string, id: string) =>
  wafv2.getIPSet({ Name: name, Scope: "REGIONAL", Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new IPSetStillExists({ name }))),
    Effect.catchTag("WAFNonexistentItemException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "IPSetStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create, update addresses and tags, replace on ip version change, delete",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const ipSet = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* IPSet("LifecycleIpSet", {
            addresses: ["192.0.2.44/32", "203.0.113.0/24"],
            description: "test block list",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(ipSet.ipAddressVersion).toBe("IPV4");
      expect(ipSet.scope).toBe("REGIONAL");
      expect([...ipSet.addresses].sort()).toEqual([
        "192.0.2.44/32",
        "203.0.113.0/24",
      ]);

      // out-of-band verification via distilled (WAF returns addresses in
      // arbitrary order)
      const created = yield* wafv2.getIPSet({
        Name: ipSet.ipSetName,
        Scope: "REGIONAL",
        Id: ipSet.ipSetId,
      });
      expect([...(created.IPSet?.Addresses ?? [])].sort()).toEqual([
        "192.0.2.44/32",
        "203.0.113.0/24",
      ]);
      expect(created.IPSet?.Description).toBe("test block list");

      const tags = yield* wafv2.listTagsForResource({
        ResourceARN: ipSet.ipSetArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.TagInfoForResource?.TagList ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.Environment).toBe("test");
      expect(tagRecord["alchemy::id"]).toBe("LifecycleIpSet");

      // addresses are mutable — updated in place
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* IPSet("LifecycleIpSet", {
            addresses: ["198.51.100.0/24"],
            description: "test block list",
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(updated.ipSetId).toBe(ipSet.ipSetId);
      expect(updated.addresses).toEqual(["198.51.100.0/24"]);

      const afterUpdate = yield* wafv2.getIPSet({
        Name: ipSet.ipSetName,
        Scope: "REGIONAL",
        Id: ipSet.ipSetId,
      });
      expect(afterUpdate.IPSet?.Addresses).toEqual(["198.51.100.0/24"]);

      // changing the IP version is immutable ⇒ replacement
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* IPSet("LifecycleIpSet", {
            ipAddressVersion: "IPV6",
            addresses: ["2620:0:2d0:200::/64"],
          });
        }),
      );
      expect(replaced.ipSetId).not.toBe(ipSet.ipSetId);
      expect(replaced.ipAddressVersion).toBe("IPV6");
      yield* assertIpSetDeleted(ipSet.ipSetName, ipSet.ipSetId);

      yield* stack.destroy();
      yield* assertIpSetDeleted(replaced.ipSetName, replaced.ipSetId);
    }),
  { timeout: 120_000 },
);
