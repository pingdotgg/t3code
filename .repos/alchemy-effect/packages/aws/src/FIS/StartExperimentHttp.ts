import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisTemplateHttpBinding } from "./BindingHttp.ts";
import { StartExperiment } from "./StartExperiment.ts";

export const StartExperimentHttp = Layer.effect(
  StartExperiment,
  makeFisTemplateHttpBinding({
    tag: "AWS.FIS.StartExperiment",
    operation: fis.startExperiment,
    // Starting also tags the created experiment (internal or caller-supplied
    // tags), which FIS authorizes as fis:TagResource on the experiment ARN.
    actions: ["fis:StartExperiment", "fis:TagResource"],
    requestKey: "experimentTemplateId",
    grantExperimentWildcard: true,
    // The first StartExperiment in an account creates AWSServiceRoleForFIS.
    grantServiceLinkedRole: true,
  }),
);
