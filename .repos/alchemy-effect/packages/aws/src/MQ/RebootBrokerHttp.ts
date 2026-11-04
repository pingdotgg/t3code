import * as mq from "@distilled.cloud/aws/mq";
import * as Layer from "effect/Layer";
import { makeMqBrokerHttpBinding } from "./BindingHttp.ts";
import { RebootBroker } from "./RebootBroker.ts";

export const RebootBrokerHttp = Layer.effect(
  RebootBroker,
  makeMqBrokerHttpBinding({
    capability: "RebootBroker",
    operation: mq.rebootBroker,
    iamActions: ["mq:RebootBroker"],
  }),
);
