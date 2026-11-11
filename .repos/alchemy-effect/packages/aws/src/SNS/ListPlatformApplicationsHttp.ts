import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { ListPlatformApplications } from "./ListPlatformApplications.ts";

export const ListPlatformApplicationsHttp = Layer.effect(
  ListPlatformApplications,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.ListPlatformApplications",
    operation: sns.listPlatformApplications,
    actions: ["sns:ListPlatformApplications"],
  }),
);
