import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PublishRequest extends iotdata.PublishRequest {}

/**
 * A capability that lets a Function publish MQTT messages to AWS IoT Core
 * topics via the IoT data plane.
 *
 * Binding to a topic filter grants the host `iot:Publish` on matching topics
 * (or on all topics when the filter is omitted) and returns a runtime callable
 * for the data-plane `Publish` API. Provide the {@link PublishHttp} layer on
 * the Function.
 *
 * @binding
 * @section Publishing Messages
 * @example Publish MQTT Messages from a Lambda
 * ```typescript
 * export default TelemetryFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     // grants iot:Publish on sensors/* to this function
 *     const publish = yield* AWS.IoT.Publish("sensors/*");
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* publish({
 *           topic: "sensors/1/telemetry",
 *           payload: JSON.stringify({ t: 22.5 }),
 *         });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(AWS.IoT.PublishHttp)),
 * );
 * ```
 */
export interface Publish extends Binding.Service<
  Publish,
  "AWS.IoT.Publish",
  (
    topicFilter?: string,
  ) => Effect.Effect<
    (
      request: PublishRequest,
    ) => Effect.Effect<iotdata.PublishResponse, iotdata.PublishError>
  >
> {}

export const Publish = Binding.Service<Publish>("AWS.IoT.Publish");
