import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeAddressListHttpBinding } from "./BindingHttp.ts";
import { CreateAddressListImportJob } from "./CreateAddressListImportJob.ts";

export const CreateAddressListImportJobHttp = Layer.effect(
  CreateAddressListImportJob,
  makeAddressListHttpBinding({
    tag: "AWS.MailManager.CreateAddressListImportJob",
    operation: mm.createAddressListImportJob,
    actions: ["ses:CreateAddressListImportJob"],
  }),
);
