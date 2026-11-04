import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { ListSecurityControlDefinitions } from "./ListSecurityControlDefinitions.ts";

export const ListSecurityControlDefinitionsHttp = Layer.effect(
  ListSecurityControlDefinitions,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.ListSecurityControlDefinitions",
    operation: securityhub.listSecurityControlDefinitions,
    actions: ["securityhub:ListSecurityControlDefinitions"],
  }),
);
