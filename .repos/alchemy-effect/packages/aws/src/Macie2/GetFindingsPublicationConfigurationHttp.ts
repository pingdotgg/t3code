import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetFindingsPublicationConfiguration } from "./GetFindingsPublicationConfiguration.ts";

export const GetFindingsPublicationConfigurationHttp = Layer.effect(
  GetFindingsPublicationConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetFindingsPublicationConfiguration",
    operation: macie2.getFindingsPublicationConfiguration,
    actions: ["macie2:GetFindingsPublicationConfiguration"],
  }),
);
