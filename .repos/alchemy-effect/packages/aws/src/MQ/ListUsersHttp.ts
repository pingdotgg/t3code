import * as mq from "@distilled.cloud/aws/mq";
import * as Layer from "effect/Layer";
import { makeMqBrokerHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeMqBrokerHttpBinding<
    Omit<mq.ListUsersRequest, "BrokerId">,
    mq.ListUsersResponse,
    mq.ListUsersError
  >({
    capability: "ListUsers",
    operation: mq.listUsers,
    iamActions: ["mq:ListUsers"],
  }),
);
