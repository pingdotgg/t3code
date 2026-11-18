import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalStreamBinding } from "./StreamHttp.ts";
import { WriteStream } from "./WriteStream.ts";

/**
 * Local implementation of the {@link WriteStream} service — POSTs records
 * to the stream's HTTP ingest endpoint with the **current credentials**
 * instead of a native Worker binding (`WriteStreamBinding`) or a scoped
 * API token (`WriteStreamHttp`).
 *
 * Provide it on an Action (or any deploy-time Effect) to send events with
 * the same typed client you use inside a Worker. The stream needs its HTTP
 * endpoint enabled (`http: true`), and the current credentials need the
 * `Pipelines Send` permission when it is authenticated.
 * ### Providing the Layer
 * **Example:** Seed a stream from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const views = yield* Cloudflare.Basin.WriteStream(PageViews);
 *     return Effect.fn(function* () {
 *       yield* views.send([new PageView({ url: "/", at: new Date() })]);
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Basin.WriteStreamLocal)),
 * );
 * ```
 *
 * @layer
 * @provides Cloudflare.Pipelines.WriteStream
 * @product Pipelines
 * @category Storage & Databases
 */
export const WriteStreamLocal = Layer.effect(
  WriteStream,
  Effect.suspend(() =>
    makeLocalStreamBinding({ layer: "WriteStreamLocal", makeClient: (client) => client }),
  ),
);
