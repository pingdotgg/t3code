import * as kafka from "@distilled.cloud/aws/kafka";
import * as Layer from "effect/Layer";
import { makeKafkaClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeTopicPartitions } from "./DescribeTopicPartitions.ts";

export const DescribeTopicPartitionsHttp = Layer.effect(
  DescribeTopicPartitions,
  makeKafkaClusterHttpBinding({
    tag: "AWS.Kafka.DescribeTopicPartitions",
    operation: kafka.describeTopicPartitions,
    actions: [
      "kafka:DescribeTopicPartitions",
      "kafka-cluster:Connect",
      "kafka-cluster:DescribeTopic",
    ],
    topicScoped: true,
  }),
);
