import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import { toWireSeconds } from "alchemy/Util/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";
import { StartBrowserSession, type StartBrowserSessionRequest } from "./StartBrowserSession.ts";

// Bespoke (not the shared scaffold): converts the ergonomic `sessionTimeout`
// Duration.Input to the wire `sessionTimeoutSeconds` field.
export const StartBrowserSessionHttp = Layer.effect(
  StartBrowserSession,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startBrowserSession = yield* AWSBindings.withCredentials(agentcore.startBrowserSession);

    return Effect.fn(function* <R extends BrowserCustom>(browser: R) {
      const Identifier = yield* browser.browserId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.BedrockAgentCore.StartBrowserSession(${browser})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["bedrock-agentcore:StartBrowserSession"],
              Resource: [browser.browserArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.BedrockAgentCore.StartBrowserSession(${browser.LogicalId})`)(
        function* ({ sessionTimeout, ...request }: StartBrowserSessionRequest) {
          return yield* startBrowserSession({
            ...request,
            sessionTimeoutSeconds: toWireSeconds(sessionTimeout),
            browserIdentifier: yield* Identifier,
          });
        },
      );
    });
  }),
);
