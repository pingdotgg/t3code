import type * as kafka from "@distilled.cloud/aws/kafka";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Runtime binding for the `GetBootstrapBrokers` operation (IAM action
 * `kafka:GetBootstrapBrokers`), scoped to one {@link ServerlessCluster}.
 *
 * Resolves the cluster's bootstrap broker connection strings at runtime —
 * for MSK Serverless the SASL/IAM string
 * (`BootstrapBrokerStringSaslIam`) is the one Kafka clients connect to.
 * Provide the implementation with
 * `Effect.provide(AWS.Kafka.GetBootstrapBrokersHttp)`.
 * @binding
 * @section Connecting to a Cluster
 * @example Resolve the SASL/IAM Bootstrap Brokers
 * ```typescript
 * const getBootstrapBrokers = yield* Kafka.GetBootstrapBrokers(cluster);
 *
 * const brokers = yield* getBootstrapBrokers();
 * // brokers.BootstrapBrokerStringSaslIam → "b-1.….kafka-serverless.…:9098"
 * ```
 */
export interface GetBootstrapBrokers extends Binding.Service<
  GetBootstrapBrokers,
  "AWS.Kafka.GetBootstrapBrokers",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    () => Effect.Effect<
      kafka.GetBootstrapBrokersResponse,
      kafka.GetBootstrapBrokersError
    >
  >
> {}
export const GetBootstrapBrokers = Binding.Service<GetBootstrapBrokers>(
  "AWS.Kafka.GetBootstrapBrokers",
);
