import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AppsDebugToken } from "./AppsDebugToken.ts";
import { bindGcpHost } from "../Host.ts";
import {
  ExchangeDebugToken,
  type ExchangeDebugTokenRequest,
} from "./ExchangeDebugToken.ts";

/**
 * HTTP implementation of {@link ExchangeDebugToken}.
 *
 * @layer
 * @provides GCP.FirebaseAppCheck.ExchangeDebugToken
 */
export const ExchangeDebugTokenHttp = Layer.effect(
  ExchangeDebugToken,
  Effect.gen(function* () {
    const exchange = yield* firebaseappcheck.exchangeDebugTokenProjectsApps;
    return Effect.fn(function* (debugToken: AppsDebugToken) {
      yield* bindGcpHost({
        tag: "GCP.FirebaseAppCheck.ExchangeDebugToken",
        resource: debugToken,
        // exchangeDebugToken is not IAM-gated; the debug token secret is the
        // credential.
        iam: [],
      });
      const app = yield* debugToken.app;
      const secret = yield* debugToken.token;
      return Effect.fn(
        `GCP.FirebaseAppCheck.ExchangeDebugToken(${debugToken.LogicalId})`,
      )(function* (request?: ExchangeDebugTokenRequest) {
        return yield* exchange({
          app: yield* app,
          body: {
            debugToken: (yield* secret) ?? "",
            limitedUse: request?.limitedUse === true ? true : undefined,
          },
        });
      });
    });
  }),
);
