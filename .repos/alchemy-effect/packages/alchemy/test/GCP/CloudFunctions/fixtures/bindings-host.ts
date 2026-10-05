import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import TargetFunction from "./target-function.ts";

/**
 * Effect-native Cloud Run service exercising every Cloud Functions binding
 * as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class CloudFunctionsBindingsHost extends GCP.Function<CloudFunctionsBindingsHost>()(
  "CloudFunctionsBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getFunction = yield* GCP.CloudFunctions.GetFunction(TargetFunction);
    const download =
      yield* GCP.CloudFunctions.GenerateDownloadUrl(TargetFunction);

    return {
      fetch: serveProbes({
        getFunction: getFunction(),
        generateDownloadUrl: download(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.CloudFunctions.GetFunctionHttp),
    Effect.provide(GCP.CloudFunctions.GenerateDownloadUrlHttp),
  ),
) {}
