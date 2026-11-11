import * as ds from "@distilled.cloud/aws/directory-service";
import * as Layer from "effect/Layer";
import { makeDirectoryHttpBinding } from "./BindingHttp.ts";
import { CreateComputer } from "./CreateComputer.ts";

export const CreateComputerHttp = Layer.effect(
  CreateComputer,
  makeDirectoryHttpBinding({
    tag: "AWS.DirectoryService.CreateComputer",
    operation: ds.createComputer,
    actions: ["ds:CreateComputer"],
  }),
);
