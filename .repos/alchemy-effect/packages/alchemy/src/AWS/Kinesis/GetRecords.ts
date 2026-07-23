import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";

export interface GetRecordsRequest extends Kinesis.GetRecordsInput {}

export class GetRecords extends Binding.Service<
  GetRecords,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: GetRecordsRequest,
    ) => Effect.Effect<Kinesis.GetRecordsOutput, Kinesis.GetRecordsError>
  >
>()("AWS.Kinesis.GetRecords") {}

export const GetRecordsLive = Layer.effect(
  GetRecords,
  Effect.gen(function* () {
    const Policy = yield* GetRecordsPolicy;
    const getRecords = yield* Kinesis.getRecords;

    return Effect.fn(function* (stream: Stream) {
      yield* Policy(stream);
      return Effect.fn(function* (request: GetRecordsRequest) {
        return yield* getRecords(request);
      });
    });
  }),
);

export class GetRecordsPolicy extends Binding.Policy<
  GetRecordsPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.GetRecords") {}

export const GetRecordsPolicyLive = GetRecordsPolicy.layer.succeed(
  Effect.fn(function* (host, stream) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.GetRecords(${stream}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["kinesis:GetRecords"],
            Resource: [stream.streamArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `GetRecordsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
