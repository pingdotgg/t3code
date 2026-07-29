import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Layer from "effect/Layer";
import { makeQuickSightEmbedHttpBinding } from "./BindingHttp.ts";
import {
  GenerateEmbedUrlForRegisteredUser,
  type GenerateEmbedUrlForRegisteredUserRequest,
} from "./GenerateEmbedUrlForRegisteredUser.ts";

export const GenerateEmbedUrlForRegisteredUserHttp = Layer.effect(
  GenerateEmbedUrlForRegisteredUser,
  makeQuickSightEmbedHttpBinding({
    tag: "AWS.QuickSight.GenerateEmbedUrlForRegisteredUser",
    operation: quicksight.generateEmbedUrlForRegisteredUser,
    actions: ["quicksight:GenerateEmbedUrlForRegisteredUser"],
    applyDefaults: (
      request: GenerateEmbedUrlForRegisteredUserRequest,
      dashboard,
    ) => ({
      ...request,
      ExperienceConfiguration: request.ExperienceConfiguration ?? {
        Dashboard: { InitialDashboardId: dashboard.dashboardId },
      },
    }),
  }),
);
