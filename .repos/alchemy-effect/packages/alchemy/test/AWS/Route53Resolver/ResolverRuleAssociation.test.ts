import * as AWS from "@/AWS";
import {
  ResolverEndpoint,
  ResolverRule,
  ResolverRuleAssociation,
} from "@/AWS/Route53Resolver";
import * as Test from "@/Test/Alchemy";
import * as r53r from "@distilled.cloud/aws/route53resolver";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  assertEndpointDeleting,
  assertRuleGone,
  defaultNetwork,
} from "./helpers.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: association APIs surface the typed
// ResourceNotFoundException tag for a nonexistent rule (against a real VPC
// — AWS validates the VPC id first with InvalidParameterException).
test.provider("associating a nonexistent rule fails with a typed tag", () =>
  Effect.gen(function* () {
    const net = yield* defaultNetwork;
    const result = yield* r53r
      .associateResolverRule({
        ResolverRuleId: "rslvr-rr-00000000000000000",
        VPCId: net.vpcId,
      })
      .pipe(
        Effect.map(() => "created" as const),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("not-found" as const),
        ),
      );
    expect(result).toBe("not-found");
  }),
);

// The full lifecycle is gated: a VPC rule association takes ~1-2 minutes to
// reach COMPLETE and another ~1-2 minutes to drain on disassociation, which
// does not fit the ungated 240s budget.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "associate a forward rule with the default VPC and tear it down",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const net = yield* defaultNetwork;
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const endpoint = yield* ResolverEndpoint("Outbound", {
            direction: "OUTBOUND",
            securityGroupIds: [net.securityGroupId],
            ipAddresses: net.subnetIds.map((subnetId) => ({ subnetId })),
          });
          const rule = yield* ResolverRule("Forward", {
            domainName: "assoc.alchemy-r53r-test.internal",
            resolverEndpointId: endpoint.resolverEndpointId,
            targetIps: [{ ip: "192.168.20.10" }],
          });
          const association = yield* ResolverRuleAssociation("Assoc", {
            resolverRuleId: rule.resolverRuleId,
            vpcId: net.vpcId,
          });
          return { endpoint, rule, association };
        }),
      );

      expect(deployed.association.resolverRuleAssociationId).toContain(
        "rslvr-rrassoc-",
      );
      expect(deployed.association.resolverRuleId).toBe(
        deployed.rule.resolverRuleId,
      );
      expect(deployed.association.vpcId).toBe(net.vpcId);

      // Out-of-band: the association exists and converges to COMPLETE
      // (VPC associations routinely take 1-2 minutes).
      const status = yield* r53r
        .getResolverRuleAssociation({
          ResolverRuleAssociationId:
            deployed.association.resolverRuleAssociationId,
        })
        .pipe(
          Effect.map((r) => r.ResolverRuleAssociation?.Status),
          Effect.repeat({
            schedule: Schedule.fixed("5 seconds"),
            until: (s) => s === "COMPLETE" || s === "FAILED",
            times: 36,
          }),
        );
      expect(status).toBe("COMPLETE");

      // Idempotent redeploy — same association (no replacement).
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          const endpoint = yield* ResolverEndpoint("Outbound", {
            direction: "OUTBOUND",
            securityGroupIds: [net.securityGroupId],
            ipAddresses: net.subnetIds.map((subnetId) => ({ subnetId })),
          });
          const rule = yield* ResolverRule("Forward", {
            domainName: "assoc.alchemy-r53r-test.internal",
            resolverEndpointId: endpoint.resolverEndpointId,
            targetIps: [{ ip: "192.168.20.10" }],
          });
          const association = yield* ResolverRuleAssociation("Assoc", {
            resolverRuleId: rule.resolverRuleId,
            vpcId: net.vpcId,
          });
          return { association };
        }),
      );
      expect(again.association.resolverRuleAssociationId).toBe(
        deployed.association.resolverRuleAssociationId,
      );

      // Destroy tears down association → rule → endpoint in order; the
      // association's delete waits for the drain so the rule delete
      // converges.
      yield* stack.destroy();
      const gone = yield* r53r
        .getResolverRuleAssociation({
          ResolverRuleAssociationId:
            deployed.association.resolverRuleAssociationId,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
      yield* assertRuleGone(deployed.rule.resolverRuleId);
      yield* assertEndpointDeleting(deployed.endpoint.resolverEndpointId);
    }),
  { timeout: 480_000 },
);
