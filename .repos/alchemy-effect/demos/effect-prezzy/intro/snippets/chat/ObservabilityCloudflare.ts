import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// #region show
export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    // Workers Observability collects and plots traces and logs itself.
    return Cloudflare.Telemetry();
  }),
);
// #endregion show
