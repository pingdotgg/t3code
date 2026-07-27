import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { virtualClusterPolicyStatement } from "./BindingHttp.ts";
import {
  GetManagedEndpointSessionCredentials,
  type GetManagedEndpointSessionCredentialsRequest,
} from "./GetManagedEndpointSessionCredentials.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

export const GetManagedEndpointSessionCredentialsHttp = Layer.effect(
  GetManagedEndpointSessionCredentials,
  Effect.gen(function* () {
    const op = yield* emrc.getManagedEndpointSessionCredentials;

    // Bespoke (not the shared builder): the request addresses the cluster as
    // `virtualClusterIdentifier` (not `virtualClusterId`) and carries a
    // `duration` that converts to the wire's `durationInSeconds`.
    return Effect.fn(function* (virtualCluster: VirtualCluster) {
      const VirtualClusterId = yield* virtualCluster.virtualClusterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.EMRContainers.GetManagedEndpointSessionCredentials(${virtualCluster}))`(
            {
              policyStatements: [
                virtualClusterPolicyStatement(virtualCluster, [
                  "emr-containers:GetManagedEndpointSessionCredentials",
                  "emr-containers:DescribeManagedEndpoint",
                ]),
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.EMRContainers.GetManagedEndpointSessionCredentials(${virtualCluster.LogicalId})`,
      )(function* (request: GetManagedEndpointSessionCredentialsRequest) {
        const { duration, ...rest } = request;
        return yield* op({
          ...rest,
          durationInSeconds: toWireSeconds(duration),
          virtualClusterIdentifier: yield* VirtualClusterId,
        });
      });
    });
  }),
);
