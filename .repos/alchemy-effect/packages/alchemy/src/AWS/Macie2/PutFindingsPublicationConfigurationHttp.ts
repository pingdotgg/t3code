import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { PutFindingsPublicationConfiguration } from "./PutFindingsPublicationConfiguration.ts";

export const PutFindingsPublicationConfigurationHttp = Layer.effect(
  PutFindingsPublicationConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.PutFindingsPublicationConfiguration",
    operation: macie2.putFindingsPublicationConfiguration,
    actions: ["macie2:PutFindingsPublicationConfiguration"],
  }),
);
