import * as kafka from "@distilled.cloud/aws/kafka";
import * as Layer from "effect/Layer";
import { makeKafkaClusterHttpBinding } from "./BindingHttp.ts";
import { GetBootstrapBrokers } from "./GetBootstrapBrokers.ts";

export const GetBootstrapBrokersHttp = Layer.effect(
  GetBootstrapBrokers,
  makeKafkaClusterHttpBinding({
    tag: "AWS.Kafka.GetBootstrapBrokers",
    operation: kafka.getBootstrapBrokers,
    actions: ["kafka:GetBootstrapBrokers"],
  }),
);
