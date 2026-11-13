import * as appsync from "@distilled.cloud/aws/appsync";
import * as Layer from "effect/Layer";
import { makeAppSyncApiHttpBinding } from "./BindingHttp.ts";
import { FlushApiCache } from "./FlushApiCache.ts";

/**
 * HTTP implementation of the {@link FlushApiCache} binding. Calls
 * `appsync:FlushApiCache` with the Lambda's IAM role. The action defines
 * no IAM resource types, so the grant is necessarily `Resource: "*"`; the
 * runtime callable itself is fixed to the bound API's `apiId`.
 */
export const FlushApiCacheHttp = Layer.effect(
  FlushApiCache,
  makeAppSyncApiHttpBinding({
    tag: "AWS.AppSync.FlushApiCache",
    actions: ["appsync:FlushApiCache"],
    operation: appsync.flushApiCache,
  }),
);
