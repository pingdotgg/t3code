import * as mq from "@distilled.cloud/aws/mq";
import * as Layer from "effect/Layer";
import { makeMqAccountHttpBinding } from "./BindingHttp.ts";
import { ListBrokers } from "./ListBrokers.ts";

export const ListBrokersHttp = Layer.effect(
  ListBrokers,
  makeMqAccountHttpBinding({
    capability: "ListBrokers",
    operation: mq.listBrokers,
    iamActions: ["mq:ListBrokers"],
  }),
);
