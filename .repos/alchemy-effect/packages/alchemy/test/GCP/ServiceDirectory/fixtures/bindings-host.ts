import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

export const Registry = GCP.ServiceDirectory.Namespace("Registry", {
  location: "us-central1",
});

/** Service the bindings are granted on (roles/servicedirectory.viewer). */
export const Api = Effect.gen(function* () {
  const namespace = yield* Registry;
  return yield* GCP.ServiceDirectory.Service("Api", {
    namespace: namespace.name,
  });
});

export const ENDPOINT_ADDRESS = "10.0.0.2";
export const ENDPOINT_PORT = 443;

export const Https = Effect.gen(function* () {
  const service = yield* Api;
  return yield* GCP.ServiceDirectory.Endpoint("Https", {
    service: service.name,
    address: ENDPOINT_ADDRESS,
    port: ENDPOINT_PORT,
  });
});

/**
 * Effect-native Cloud Run service exercising every Service Directory
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class ServiceDirectoryBindingsHost extends GCP.Function<ServiceDirectoryBindingsHost>()(
  "ServiceDirectoryBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const resolve = yield* GCP.ServiceDirectory.Resolve(Api);
    const getEndpoint = yield* GCP.ServiceDirectory.GetEndpoint(Https);

    return {
      fetch: serveProbes({
        resolve: resolve(),
        getEndpoint: getEndpoint(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.ServiceDirectory.ResolveHttp),
    Effect.provide(GCP.ServiceDirectory.GetEndpointHttp),
  ),
) {}
