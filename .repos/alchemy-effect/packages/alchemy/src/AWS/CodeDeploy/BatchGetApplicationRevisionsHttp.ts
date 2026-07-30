import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Layer from "effect/Layer";
import { BatchGetApplicationRevisions } from "./BatchGetApplicationRevisions.ts";
import { makeCodeDeployApplicationHttpBinding } from "./BindingHttp.ts";

export const BatchGetApplicationRevisionsHttp = Layer.effect(
  BatchGetApplicationRevisions,
  makeCodeDeployApplicationHttpBinding({
    tag: "AWS.CodeDeploy.BatchGetApplicationRevisions",
    operation: codedeploy.batchGetApplicationRevisions,
    actions: ["codedeploy:BatchGetApplicationRevisions"],
  }),
);
