import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";
const targetArn = process.env.ALCHEMY_TEST_VPC_LINK_TARGET_ARN;

/**
 * Requires a load balancer ARN accepted by API Gateway VPC links (set env when running live).
 */
test.provider.skipIf(!runLive || !targetArn)(
  "create, update description, delete VPC link",
  (stack) =>
    Effect.gen(function* () {
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
    }),
);
