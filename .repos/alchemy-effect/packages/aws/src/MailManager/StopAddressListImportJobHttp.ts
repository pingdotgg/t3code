import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeAddressListJobHttpBinding } from "./BindingHttp.ts";
import { StopAddressListImportJob } from "./StopAddressListImportJob.ts";

export const StopAddressListImportJobHttp = Layer.effect(
  StopAddressListImportJob,
  makeAddressListJobHttpBinding({
    tag: "AWS.MailManager.StopAddressListImportJob",
    operation: mm.stopAddressListImportJob,
    actions: ["ses:StopAddressListImportJob"],
  }),
);
