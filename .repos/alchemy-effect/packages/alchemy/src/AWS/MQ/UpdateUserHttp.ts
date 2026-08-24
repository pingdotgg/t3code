import * as mq from "@distilled.cloud/aws/mq";
import * as Layer from "effect/Layer";
import { makeMqBrokerHttpBinding } from "./BindingHttp.ts";
import { UpdateUser } from "./UpdateUser.ts";

export const UpdateUserHttp = Layer.effect(
  UpdateUser,
  makeMqBrokerHttpBinding<
    Omit<mq.UpdateUserRequest, "BrokerId">,
    mq.UpdateUserResponse,
    mq.UpdateUserError
  >({
    capability: "UpdateUser",
    operation: mq.updateUser,
    iamActions: ["mq:UpdateUser"],
  }),
);
