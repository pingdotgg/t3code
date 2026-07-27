import * as amplify from "@distilled.cloud/aws/amplify";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { App } from "./App.ts";
import {
  GetArtifactUrl,
  type GetArtifactUrlRequest,
} from "./GetArtifactUrl.ts";

// Bespoke (not via makeAmplifyHttpBinding): GetArtifactUrl addresses the
// artifact by its globally-unique `artifactId` alone — there is no `appId`
// to inject. The app is still bound for the IAM grant over its artifacts.
export const GetArtifactUrlHttp = Layer.effect(
  GetArtifactUrl,
  Effect.gen(function* () {
    const getArtifactUrl = yield* amplify.getArtifactUrl;

    return Effect.fn(function* (app: App) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Amplify.GetArtifactUrl(${app}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["amplify:GetArtifactUrl"],
                Resource: [
                  Output.interpolate`${app.appArn}/branches/*/jobs/*/artifacts/*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Amplify.GetArtifactUrl(${app.LogicalId})`)(
        function* (request: GetArtifactUrlRequest) {
          return yield* getArtifactUrl(request);
        },
      );
    });
  }),
);
