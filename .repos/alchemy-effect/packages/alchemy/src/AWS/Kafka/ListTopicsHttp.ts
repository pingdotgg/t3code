import * as kafka from "@distilled.cloud/aws/kafka";
import * as Layer from "effect/Layer";
import { makeKafkaClusterHttpBinding } from "./BindingHttp.ts";
import { ListTopics } from "./ListTopics.ts";

export const ListTopicsHttp = Layer.effect(
  ListTopics,
  makeKafkaClusterHttpBinding({
    tag: "AWS.Kafka.ListTopics",
    operation: kafka.listTopics,
    actions: [
      "kafka:ListTopics",
      "kafka-cluster:Connect",
      "kafka-cluster:DescribeTopic",
    ],
    topicScoped: true,
  }),
);
