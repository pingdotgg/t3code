import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { DescribeVirtualCluster } from "./DescribeVirtualCluster.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

/**
 * Bespoke (not scaffold-built): `describeVirtualCluster` addresses the
 * virtual cluster itself via `id` rather than carrying a `virtualClusterId`
 * field, and the grant is on the cluster ARN alone (no sub-resource
 * pattern).
 */
export const DescribeVirtualClusterHttp = Layer.effect(
  DescribeVirtualCluster,
  Effect.gen(function* () {
    const op = yield* emrc.describeVirtualCluster;

    return Effect.fn(function* (virtualCluster: VirtualCluster) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const VirtualClusterId = yield* virtualCluster.virtualClusterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.EMRContainers.DescribeVirtualCluster(${virtualCluster}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["emr-containers:DescribeVirtualCluster"],
                  Resource: [virtualCluster.virtualClusterArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.EMRContainers.DescribeVirtualCluster(${virtualCluster.LogicalId})`,
      )(function* () {
        return yield* op({ id: yield* VirtualClusterId });
      });
    });
  }),
);
