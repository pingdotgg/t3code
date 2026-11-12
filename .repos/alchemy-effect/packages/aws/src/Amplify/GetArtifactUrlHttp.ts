import * as amplify from "@distilled.cloud/aws/amplify";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { App } from "./App.ts";
import { GetArtifactUrl, type GetArtifactUrlRequest } from "./GetArtifactUrl.ts";

// Bespoke (not via makeAmplifyHttpBinding): GetArtifactUrl addresses the
// artifact by its globally-unique `artifactId` alone — there is no `appId`
// to inject. The app is still bound for the IAM grant over its artifacts.
export const GetArtifactUrlHttp = Layer.effect(
  GetArtifactUrl,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const getArtifactUrl = yield* AWSBindings.withCredentials(amplify.getArtifactUrl);

    return Effect.fn(function* (app: App) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Amplify.GetArtifactUrl(${app})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["amplify:GetArtifactUrl"],
              Resource: [Output.interpolate`${app.appArn}/branches/*/jobs/*/artifacts/*`],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Amplify.GetArtifactUrl(${app.LogicalId})`)(function* (
        request: GetArtifactUrlRequest,
      ) {
        return yield* getArtifactUrl(request);
      });
    });
  }),
);
