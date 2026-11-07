import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotTopicHttpBinding } from "./BindingHttp.ts";
import { Publish } from "./Publish.ts";

/**
 * HTTP implementation of the {@link Publish} capability.
 *
 * At deploy time it attaches an IAM policy statement granting `iot:Publish`
 * on the bound topic filter (`arn:aws:iot:...:topic/{filter}`); at runtime it
 * calls the IoT data-plane `Publish` API over HTTPS.
 *
 * @example Provide the layer on a Lambda Function
 * ```typescript
 * export default TelemetryFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const publish = yield* AWS.IoT.Publish("sensors/*");
 *     // ... handlers that call `publish({ topic, payload })`
 *   }).pipe(Effect.provide(AWS.IoT.PublishHttp)),
 * );
 * ```
 */
export const PublishHttp = Layer.effect(
  Publish,
  makeIotTopicHttpBinding({
    tag: "AWS.IoT.Publish",
    operation: iotdata.publish,
    // RetainPublish authorizes `retain: true` publishes (a separate IAM
    // action from plain Publish) on the same topic filter.
    actions: ["iot:Publish", "iot:RetainPublish"],
  }),
);
