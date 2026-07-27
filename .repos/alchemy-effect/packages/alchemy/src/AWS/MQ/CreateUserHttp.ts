import * as mq from "@distilled.cloud/aws/mq";
import * as Layer from "effect/Layer";
import { makeMqBrokerHttpBinding } from "./BindingHttp.ts";
import { CreateUser } from "./CreateUser.ts";

export const CreateUserHttp = Layer.effect(
  CreateUser,
  makeMqBrokerHttpBinding<
    Omit<mq.CreateUserRequest, "BrokerId">,
    mq.CreateUserResponse,
    mq.CreateUserError
  >({
    capability: "CreateUser",
    operation: mq.createUser,
    iamActions: ["mq:CreateUser"],
  }),
);
