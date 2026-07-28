import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { CreateSampleFindings } from "./CreateSampleFindings.ts";

export const CreateSampleFindingsHttp = Layer.effect(
  CreateSampleFindings,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.CreateSampleFindings",
    operation: macie2.createSampleFindings,
    actions: ["macie2:CreateSampleFindings"],
  }),
);
