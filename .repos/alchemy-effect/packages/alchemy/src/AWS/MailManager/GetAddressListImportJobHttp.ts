import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeAddressListJobHttpBinding } from "./BindingHttp.ts";
import { GetAddressListImportJob } from "./GetAddressListImportJob.ts";

export const GetAddressListImportJobHttp = Layer.effect(
  GetAddressListImportJob,
  makeAddressListJobHttpBinding({
    tag: "AWS.MailManager.GetAddressListImportJob",
    operation: mm.getAddressListImportJob,
    actions: ["ses:GetAddressListImportJob"],
  }),
);
