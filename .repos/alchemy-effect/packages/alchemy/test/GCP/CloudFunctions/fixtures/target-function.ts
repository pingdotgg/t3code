import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Minimal Effect-native Cloud Function the Cloud Functions bindings are
 * granted on. Declared by {@link ./bindings-host.ts}.
 */
export default class TargetFunction extends GCP.CloudFunctions.Function<TargetFunction>()(
  "TargetFunction",
  { main: import.meta.url, location: "us-central1" },
  Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
) {}
