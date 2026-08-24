import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataSetHttpBinding } from "./BindingHttp.ts";
import { SendDataSetNotification } from "./SendDataSetNotification.ts";

export const SendDataSetNotificationHttp = Layer.effect(
  SendDataSetNotification,
  makeDataSetHttpBinding({
    tag: "AWS.DataExchange.SendDataSetNotification",
    operation: dataexchange.sendDataSetNotification,
    actions: ["dataexchange:SendDataSetNotification"],
  }),
);
