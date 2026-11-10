import * as Telemetry from "alchemy/Telemetry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ObservabilityLive as Axiom } from "./Observability.ts";

// #region show
export const Honeycomb = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("HONEYCOMB_API_KEY");
    return Telemetry.layerOtlp({
      url: "https://api.honeycomb.io",
      headers: { "x-honeycomb-team": apiKey },
    });
  }),
);

export const ObservabilityLive = Layer.mergeAll(Axiom, Honeycomb);
// #endregion show
