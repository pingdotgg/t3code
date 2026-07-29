import * as Layer from "effect/Layer";
import { ConnectRead } from "./Connect.ts";
import {
  KAFKA_CONNECT_ACTIONS,
  KAFKA_READ_GROUP_ACTIONS,
  KAFKA_READ_TOPIC_ACTIONS,
  makeKafkaConnectHttpBinding,
} from "./ConnectHttp.ts";

export const ConnectReadHttp = Layer.effect(
  ConnectRead,
  makeKafkaConnectHttpBinding({
    tag: "AWS.Kafka.ConnectRead",
    clusterActions: KAFKA_CONNECT_ACTIONS,
    topicActions: KAFKA_READ_TOPIC_ACTIONS,
    groupActions: KAFKA_READ_GROUP_ACTIONS,
  }),
);
