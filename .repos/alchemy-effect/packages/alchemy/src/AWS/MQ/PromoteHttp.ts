import * as mq from "@distilled.cloud/aws/mq";
import * as Layer from "effect/Layer";
import { makeMqBrokerHttpBinding } from "./BindingHttp.ts";
import { Promote } from "./Promote.ts";

export const PromoteHttp = Layer.effect(
  Promote,
  makeMqBrokerHttpBinding<
    Omit<mq.PromoteRequest, "BrokerId">,
    mq.PromoteResponse,
    mq.PromoteError
  >({
    capability: "Promote",
    operation: mq.promote,
    iamActions: ["mq:Promote"],
  }),
);
