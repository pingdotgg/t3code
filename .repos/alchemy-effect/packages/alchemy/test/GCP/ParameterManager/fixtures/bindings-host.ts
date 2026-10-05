import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

export const PAYLOAD = JSON.stringify({ host: "api.example.com" });

export const AppConfig = GCP.ParameterManager.Parameter("AppConfig", {
  format: "JSON",
});

export const V1 = Effect.gen(function* () {
  const parameter = yield* AppConfig;
  return yield* GCP.ParameterManager.ParametersVersion("V1", {
    parameter: parameter.name,
    data: PAYLOAD,
  });
});

/**
 * Effect-native Cloud Run service exercising every Parameter Manager
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class ParameterManagerBindingsHost extends GCP.Function<ParameterManagerBindingsHost>()(
  "ParameterManagerBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getParameter = yield* GCP.ParameterManager.GetParameter(AppConfig);
    const getVersion = yield* GCP.ParameterManager.GetParameterVersion(V1);
    const render = yield* GCP.ParameterManager.RenderParameterVersion(V1);

    return {
      fetch: serveProbes({
        getParameter: getParameter(),
        getParameterVersion: getVersion(),
        renderParameterVersion: render(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.ParameterManager.GetParameterHttp),
    Effect.provide(GCP.ParameterManager.GetParameterVersionHttp),
    Effect.provide(GCP.ParameterManager.RenderParameterVersionHttp),
  ),
) {}
