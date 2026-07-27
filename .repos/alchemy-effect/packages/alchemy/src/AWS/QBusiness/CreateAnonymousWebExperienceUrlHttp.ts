import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { toWireMinutes } from "../../Util/Duration.ts";
import { makeQBusinessWebExperienceHttpBinding } from "./BindingHttp.ts";
import {
  CreateAnonymousWebExperienceUrl,
  type CreateAnonymousWebExperienceUrlRequest,
} from "./CreateAnonymousWebExperienceUrl.ts";

export const CreateAnonymousWebExperienceUrlHttp = Layer.effect(
  CreateAnonymousWebExperienceUrl,
  makeQBusinessWebExperienceHttpBinding({
    tag: "AWS.QBusiness.CreateAnonymousWebExperienceUrl",
    operation: qbusiness.createAnonymousWebExperienceUrl,
    actions: ["qbusiness:CreateAnonymousWebExperienceUrl"],
    prepare: (request: CreateAnonymousWebExperienceUrlRequest | undefined) => ({
      sessionDurationInMinutes: toWireMinutes(request?.sessionDuration),
    }),
  }),
);
