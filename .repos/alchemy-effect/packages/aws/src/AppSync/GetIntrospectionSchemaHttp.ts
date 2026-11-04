import * as appsync from "@distilled.cloud/aws/appsync";
import * as Layer from "effect/Layer";
import { makeAppSyncApiHttpBinding } from "./BindingHttp.ts";
import { GetIntrospectionSchema } from "./GetIntrospectionSchema.ts";

/**
 * HTTP implementation of the {@link GetIntrospectionSchema} binding. Calls
 * `appsync:GetIntrospectionSchema` with the host Function's IAM role. The
 * action defines no IAM resource types, so the grant is necessarily
 * `Resource: "*"`; the runtime callable itself is fixed to the bound API's
 * `apiId`.
 */
export const GetIntrospectionSchemaHttp = Layer.effect(
  GetIntrospectionSchema,
  makeAppSyncApiHttpBinding({
    tag: "AWS.AppSync.GetIntrospectionSchema",
    actions: ["appsync:GetIntrospectionSchema"],
    operation: appsync.getIntrospectionSchema,
  }),
);
