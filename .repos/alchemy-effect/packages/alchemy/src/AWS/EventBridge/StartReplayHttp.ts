import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Archive } from "./Archive.ts";
import { StartReplay, type StartReplayRequest } from "./StartReplay.ts";

/**
 * HTTP implementation of {@link StartReplay}. At deploy time it grants
 * `events:StartReplay` on the account's replays (replay names are chosen at
 * runtime, so the grant is the `replay/*` wildcard); at runtime it calls the
 * EventBridge API with the host Function's credentials, injecting the bound
 * archive's ARN as the `EventSourceArn`. Provide this layer on the Function
 * using the binding.
 */
export const StartReplayHttp = Layer.effect(
  StartReplay,
  Effect.gen(function* () {
    const startReplay = yield* eventbridge.startReplay;

    return Effect.fn(function* (archive: Archive) {
      const ArchiveArn = yield* archive.archiveArn;
      const EventSourceArn = yield* archive.eventSourceArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          yield* host.bind`Allow(${host}, AWS.EventBridge.StartReplay(${archive}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["events:StartReplay"],
                  Resource: [
                    `arn:aws:events:${region}:${accountId}:replay/*`,
                    // StartReplay also authorizes against the source archive.
                    archive.archiveArn,
                    // ...and against the DESTINATION event bus. EventBridge
                    // only allows replaying to the archive's source bus, so
                    // that bus ARN covers every legal destination.
                    archive.eventSourceArn,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.EventBridge.StartReplay(${archive.LogicalId})`)(
        function* (request: StartReplayRequest) {
          return yield* startReplay({
            ...request,
            EventSourceArn: yield* ArchiveArn,
            // Default the destination to the archive's source bus — the only
            // destination EventBridge accepts for a replay.
            Destination: request.Destination ?? {
              Arn: yield* EventSourceArn,
            },
          });
        },
      );
    });
  }),
);
