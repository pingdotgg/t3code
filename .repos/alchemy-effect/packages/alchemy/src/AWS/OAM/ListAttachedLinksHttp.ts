import * as oam from "@distilled.cloud/aws/oam";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  ListAttachedLinks,
  type ListAttachedLinksRequest,
} from "./ListAttachedLinks.ts";
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
    const listAttachedLinks = yield* oam.listAttachedLinks;

    return Effect.fn(function* (sink: Sink) {
      const SinkIdentifier = yield* sink.sinkArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.OAM.ListAttachedLinks(${sink}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["oam:ListAttachedLinks"],
                Resource: [sink.sinkArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.OAM.ListAttachedLinks(${sink.LogicalId})`)(
        function* (request?: ListAttachedLinksRequest) {
          return yield* listAttachedLinks({
            ...request,
            SinkIdentifier: yield* SinkIdentifier,
          });
        },
      );
    });
  }),
);
