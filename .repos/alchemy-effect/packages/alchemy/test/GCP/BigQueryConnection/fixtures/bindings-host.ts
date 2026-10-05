import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Connection the host reads (roles/bigquery.connectionUser on it). */
export const Cloud = GCP.BigQueryConnection.Connection("Cloud", {
  location: "us-central1",
  cloudResource: {},
});

/**
 * Effect-native Cloud Run service exercising every BigQuery Connection
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class BigQueryConnectionBindingsHost extends GCP.Function<BigQueryConnectionBindingsHost>()(
  "BigQueryConnectionBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getConnection = yield* GCP.BigQueryConnection.GetConnection(Cloud);

    return {
      fetch: serveProbes({
        getConnection: getConnection(),
      }),
    };
  }).pipe(Effect.provide(GCP.BigQueryConnection.GetConnectionHttp)),
) {}
