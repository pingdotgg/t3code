import * as amplify from "@distilled.cloud/aws/amplify";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";
import { ListArtifacts } from "./ListArtifacts.ts";

export const ListArtifactsHttp = Layer.effect(
  ListArtifacts,
  makeAmplifyHttpBinding({
    name: "ListArtifacts",
    operation: amplify.listArtifacts,
    actions: ["amplify:ListArtifacts"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*/jobs/*`],
  }),
);
