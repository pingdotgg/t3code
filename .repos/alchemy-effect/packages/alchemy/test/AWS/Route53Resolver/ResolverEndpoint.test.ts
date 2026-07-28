import * as AWS from "@/AWS";
import { ResolverEndpoint } from "@/AWS/Route53Resolver";
import * as Test from "@/Test/Alchemy";
import * as r53r from "@distilled.cloud/aws/route53resolver";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertEndpointDeleting, defaultNetwork } from "./helpers.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update tags, delete an inbound resolver endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const net = yield* defaultNetwork;
      const make = (tags: Record<string, string>) =>
        Effect.gen(function* () {
          const endpoint = yield* ResolverEndpoint("Inbound", {
            direction: "INBOUND",
            securityGroupIds: [net.securityGroupId],
            ipAddresses: net.subnetIds.map((subnetId) => ({ subnetId })),
            tags,
          });
          return { endpoint };
        });

      const { endpoint } = yield* stack.deploy(
        make({ fixture: "r53r-endpoint" }),
      );

      expect(endpoint.resolverEndpointId).toMatch(/^rslvr-in-/);
      expect(endpoint.direction).toBe("INBOUND");
      expect(endpoint.hostVpcId).toBe(net.vpcId);
      expect(endpoint.resolverEndpointArn).toContain(":resolver-endpoint/");

      // Out-of-band: the endpoint is OPERATIONAL (reconcile waits for it)
      // and carries both the fixture tag and the internal Alchemy tags.
      const observed = yield* r53r.getResolverEndpoint({
        ResolverEndpointId: endpoint.resolverEndpointId,
      });
      expect(observed.ResolverEndpoint?.Status).toBe("OPERATIONAL");
      expect(observed.ResolverEndpoint?.Direction).toBe("INBOUND");
      expect(observed.ResolverEndpoint?.IpAddressCount).toBe(2);
      const tags = yield* r53r.listTagsForResource({
        ResourceArn: endpoint.resolverEndpointArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.fixture).toBe("r53r-endpoint");
      expect(tagRecord["alchemy::id"]).toBe("Inbound");

      // In-place tag update — same endpoint (no replacement).
      const { endpoint: updated } = yield* stack.deploy(make({ team: "dns" }));
      expect(updated.resolverEndpointId).toBe(endpoint.resolverEndpointId);
      const tagsAfter = yield* r53r.listTagsForResource({
        ResourceArn: endpoint.resolverEndpointArn,
      });
      const tagRecordAfter = Object.fromEntries(
        (tagsAfter.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecordAfter.team).toBe("dns");
      expect(tagRecordAfter.fixture).toBeUndefined();
      expect(tagRecordAfter["alchemy::id"]).toBe("Inbound");

      yield* stack.destroy();
      yield* assertEndpointDeleting(endpoint.resolverEndpointId);
    }),
  { timeout: 220_000 },
);
