import * as oam from "@distilled.cloud/aws/oam";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { ListAttachedLinks, type ListAttachedLinksRequest } from "./ListAttachedLinks.ts";
import type { Sink } from "./Sink.ts";

/**
 * HTTP implementation of {@link ListAttachedLinks}: grants
 * `oam:ListAttachedLinks` on the bound sink and calls the OAM HTTP API with
 * the function's IAM credentials, injecting the sink's ARN as the
 * `SinkIdentifier`.
 */
export const ListAttachedLinksHttp = Layer.effect(
  ListAttachedLinks,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const listAttachedLinks = yield* AWSBindings.withCredentials(oam.listAttachedLinks);

    return Effect.fn(function* (sink: Sink) {
      const SinkIdentifier = yield* sink.sinkArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.OAM.ListAttachedLinks(${sink})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["oam:ListAttachedLinks"],
              Resource: [sink.sinkArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.OAM.ListAttachedLinks(${sink.LogicalId})`)(function* (
        request?: ListAttachedLinksRequest,
      ) {
        return yield* listAttachedLinks({
          ...request,
          SinkIdentifier: yield* SinkIdentifier,
        });
      });
    });
  }),
);
