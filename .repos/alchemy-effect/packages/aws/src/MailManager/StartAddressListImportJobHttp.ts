import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeAddressListJobHttpBinding } from "./BindingHttp.ts";
import { StartAddressListImportJob } from "./StartAddressListImportJob.ts";

export const StartAddressListImportJobHttp = Layer.effect(
  StartAddressListImportJob,
  makeAddressListJobHttpBinding({
    tag: "AWS.MailManager.StartAddressListImportJob",
    operation: mm.startAddressListImportJob,
    actions: ["ses:StartAddressListImportJob"],
  }),
);
