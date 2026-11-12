import * as mq from "@distilled.cloud/aws/mq";
import * as Layer from "effect/Layer";
import { makeMqBrokerHttpBinding } from "./BindingHttp.ts";
import { DescribeUser } from "./DescribeUser.ts";

export const DescribeUserHttp = Layer.effect(
  DescribeUser,
  makeMqBrokerHttpBinding<
    Omit<mq.DescribeUserRequest, "BrokerId">,
    mq.DescribeUserResponse,
    mq.DescribeUserError
  >({
    capability: "DescribeUser",
    operation: mq.describeUser,
    iamActions: ["mq:DescribeUser"],
  }),
);
