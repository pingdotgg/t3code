import * as dsql from "@distilled.cloud/aws/dsql";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";
import { GetVpcEndpointServiceName } from "./GetVpcEndpointServiceName.ts";

/**
 * HTTP implementation of {@link GetVpcEndpointServiceName}. At deploy time
 * it grants `dsql:GetVpcEndpointServiceName` on the cluster to the host
 * Function; at runtime it calls the DSQL control plane with the Function's
 * own credentials.
 */
export const GetVpcEndpointServiceNameHttp = Layer.effect(
  GetVpcEndpointServiceName,
  Effect.gen(function* () {
    const op = yield* dsql.getVpcEndpointServiceName;

    return Effect.fn(function* <R extends Cluster>(cluster: R) {
      const Identifier = yield* cluster.clusterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DSQL.GetVpcEndpointServiceName(${cluster}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dsql:GetVpcEndpointServiceName"],
                  Resource: [cluster.clusterArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.DSQL.GetVpcEndpointServiceName(${cluster.LogicalId})`,
      )(function* () {
        return yield* op({ identifier: yield* Identifier });
      });
    });
  }),
);
