import * as kafka from "@distilled.cloud/aws/kafka";
import * as Layer from "effect/Layer";
import { makeKafkaClusterHttpBinding } from "./BindingHttp.ts";
import { DeleteTopic } from "./DeleteTopic.ts";

export const DeleteTopicHttp = Layer.effect(
  DeleteTopic,
  makeKafkaClusterHttpBinding({
    tag: "AWS.Kafka.DeleteTopic",
    operation: kafka.deleteTopic,
    actions: [
      "kafka:DeleteTopic",
      "kafka-cluster:Connect",
      "kafka-cluster:DeleteTopic",
    ],
    topicScoped: true,
  }),
);
