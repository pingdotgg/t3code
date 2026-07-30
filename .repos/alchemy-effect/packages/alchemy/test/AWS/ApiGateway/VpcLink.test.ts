import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertVpcLinkDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

const targetArn = process.env.ALCHEMY_TEST_VPC_LINK_TARGET_ARN;

/**
 * Requires a load balancer ARN accepted by API Gateway VPC links (set env when running live).
 */
test.provider.skipIf(!!process.env.FAST || !targetArn)(
  "create, update description, delete VPC link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const arn = targetArn!;

      const link = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.VpcLink("AgVpcLinkTest", {
            description: "v1",
            targetArns: [arn],
          });
        }),
      );

      expect(link.vpcLinkId).toBeDefined();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.VpcLink("AgVpcLinkTest", {
            description: "v2",
            targetArns: [arn],
          });
        }),
      );

      const remote = yield* ag.getVpcLink({ vpcLinkId: link.vpcLinkId });
      expect(remote.description).toEqual("v2");

      yield* stack.destroy();
      yield* assertVpcLinkDeleted(link.vpcLinkId);
    }),
);

/**
 * A VPC link requires an NLB target ARN, which is heavy to provision in CI,
 * so this is gated behind the same env vars as the lifecycle test above.
 */
test.provider.skipIf(!!process.env.FAST || !targetArn)(
  "list enumerates the deployed VPC link",
  (stack) =>
    Effect.gen(function* () {
      const arn = targetArn!;

      yield* stack.destroy();

      const link = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.VpcLink("AgVpcLinkList", {
            description: "list",
            targetArns: [arn],
          });
        }),
      );

      const provider = yield* Provider.findProvider(AWS.ApiGateway.VpcLink);
      const all = yield* provider.list();

      expect(all.some((v) => v.vpcLinkId === link.vpcLinkId)).toBe(true);

      yield* stack.destroy();
      yield* assertVpcLinkDeleted(link.vpcLinkId);
    }),
);
