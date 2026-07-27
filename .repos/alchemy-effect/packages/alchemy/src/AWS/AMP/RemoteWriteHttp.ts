import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAmpWorkspaceHttpBinding } from "./BindingHttp.ts";
import { RemoteWrite, type RemoteWriteRequest } from "./RemoteWrite.ts";
import {
  encodeWriteRequest,
  snappyCompress,
  type EncodableSeries,
} from "./RemoteWriteCodec.ts";

export const RemoteWriteHttp = Layer.effect(
  RemoteWrite,
  makeAmpWorkspaceHttpBinding({
    name: "RemoteWrite",
    iamActions: ["aps:RemoteWrite"],
    makeClient: (send) => (request: RemoteWriteRequest) =>
      Effect.gen(function* () {
        const body = yield* Effect.sync(() => {
          const now = Date.now();
          const timeseries: EncodableSeries[] = request.timeseries.map(
            (series) => ({
              labels: { ...series.labels, __name__: series.name },
              samples: series.samples.map((sample) => ({
                value: sample.value,
                timestamp: sample.timestamp ?? now,
              })),
            }),
          );
          return snappyCompress(encodeWriteRequest(timeseries));
        });
        yield* send({
          method: "POST",
          path: "api/v1/remote_write",
          bytes: {
            data: body,
            contentType: "application/x-protobuf",
            headers: {
              "content-encoding": "snappy",
              "x-prometheus-remote-write-version": "0.1.0",
            },
          },
        });
      }),
  }),
);
