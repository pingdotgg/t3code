import * as Layer from "effect/Layer";
import { ConnectReadWrite } from "./Connect.ts";
import {
  KAFKA_CONNECT_ACTIONS,
  KAFKA_READ_GROUP_ACTIONS,
  KAFKA_READ_TOPIC_ACTIONS,
  KAFKA_WRITE_CLUSTER_ACTIONS,
  KAFKA_WRITE_TOPIC_ACTIONS,
  KAFKA_WRITE_TRANSACTION_ACTIONS,
  makeKafkaConnectHttpBinding,
} from "./ConnectHttp.ts";

export const ConnectReadWriteHttp = Layer.effect(
  ConnectReadWrite,
  makeKafkaConnectHttpBinding({
    tag: "AWS.Kafka.ConnectReadWrite",
    clusterActions: [...KAFKA_CONNECT_ACTIONS, ...KAFKA_WRITE_CLUSTER_ACTIONS],
    topicActions: [
      ...new Set([...KAFKA_READ_TOPIC_ACTIONS, ...KAFKA_WRITE_TOPIC_ACTIONS]),
    ],
    groupActions: KAFKA_READ_GROUP_ACTIONS,
    transactionActions: KAFKA_WRITE_TRANSACTION_ACTIONS,
  }),
);
