import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import { toWireMinutes } from "alchemy/Util/Duration";
import * as Layer from "effect/Layer";
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
