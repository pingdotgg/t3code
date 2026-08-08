import * as kafka from "@distilled.cloud/aws/kafka";
import * as Layer from "effect/Layer";
import { makeKafkaClusterHttpBinding } from "./BindingHttp.ts";
import { CreateTopic } from "./CreateTopic.ts";

export const CreateTopicHttp = Layer.effect(
  CreateTopic,
  makeKafkaClusterHttpBinding({
    tag: "AWS.Kafka.CreateTopic",
    operation: kafka.createTopic,
    // The control-plane action authorizes against the topic ARN; the
    // kafka-cluster analogs cover the underlying Kafka admin operation.
    actions: [
      "kafka:CreateTopic",
      "kafka-cluster:Connect",
      "kafka-cluster:CreateTopic",
    ],
    topicScoped: true,
  }),
);
