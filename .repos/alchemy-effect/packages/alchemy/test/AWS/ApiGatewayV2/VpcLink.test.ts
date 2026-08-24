import * as AWS from "@/AWS";
import { VpcLink } from "@/AWS/ApiGatewayV2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getDefaultVpc } from "../DefaultVpc";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated live probe: `list()` enumerates every v2 VPC link and maps each
// item to the `read` Attributes shape.
test.provider.skipIf(!!process.env.FAST)(
  "list returns the account/region VPC links",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(VpcLink);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const link of all) {
        expect(typeof link.vpcLinkId).toBe("string");
        expect(Array.isArray(link.subnetIds)).toBe(true);
      }
    }),
);

// Full lifecycle. SKIPPED by default: a v2 VPC link takes ~1-2 minutes to
// reach AVAILABLE (and a comparable window to release its ENIs on delete),
// which exceeds the suite's provisioning-wait budget. Set
// AWS_TEST_APIGWV2_VPCLINK=1 to run it against the default VPC's subnets.
test.provider.skipIf(
  !!process.env.FAST || !process.env.AWS_TEST_APIGWV2_VPCLINK,
)(
  "create, rename, delete VPC link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { vpcId } = yield* getDefaultVpc;
      const described = yield* EC2.describeSubnets({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      });
      const subnets = (described.Subnets ?? [])
        .map((subnet) => subnet.SubnetId)
        .filter((id): id is string => id != null)
        .slice(0, 2);
      expect(subnets.length).toBeGreaterThan(0);

      const deployLink = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* AWS.ApiGatewayV2.VpcLink("V2Link", {
              name: `alchemy-v2link-${description}`,
              subnetIds: subnets,
            });
          }),
        );

      const link = yield* deployLink("v1");
      expect(link.vpcLinkId).toBeTruthy();

      const remote = yield* agw2.getVpcLink({ VpcLinkId: link.vpcLinkId });
      expect(remote.Name).toBe("alchemy-v2link-v1");
      expect([...(remote.SubnetIds ?? [])].sort()).toEqual([...subnets].sort());

      // Rename in place (name is the only mutable prop).
      const renamed = yield* deployLink("v2");
      expect(renamed.vpcLinkId).toBe(link.vpcLinkId);
      const afterRename = yield* agw2.getVpcLink({
        VpcLinkId: link.vpcLinkId,
      });
      expect(afterRename.Name).toBe("alchemy-v2link-v2");

      yield* stack.destroy();

      const gone = yield* agw2.getVpcLink({ VpcLinkId: link.vpcLinkId }).pipe(
        // DELETING still resolves; the link is fully gone on NotFound.
        Effect.map((r) => r.VpcLinkStatus ?? "unknown"),
        Effect.catchTag("NotFoundException", () =>
          Effect.succeed("deleted" as const),
        ),
      );
      expect(["deleted", "DELETING"]).toContain(gone);
    }),
  { timeout: 480_000 },
);
