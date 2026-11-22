// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Planetscale from "@alchemy.run/planetscale";

import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { relayDatabaseProviderConfig } from "./src/dbConfig.ts";
import { MobileSourceMapsUploadCredentials, RelayObservability } from "./src/observability.ts";
import { isPreviewStage } from "./src/previewStages.ts";
import { PreviewTunnelSweep, PreviewTunnelSweepProvider } from "./src/previewTunnelSweep.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
      PreviewTunnelSweepProvider(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const db =
      (yield* relayDatabaseProviderConfig) === "external"
        ? undefined
        : yield* RelayDb.PlanetscaleDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const mobileSourceMapsUploadCredentials = yield* MobileSourceMapsUploadCredentials;
    const api = yield* RelayWorker.Api;
    if (isPreviewStage(stage)) {
      const { managedEndpointZoneName } = yield* RelayDeploymentConfig;
      yield* PreviewTunnelSweep("PreviewTunnelSweep", {
        stage,
        tunnelZoneName: managedEndpointZoneName,
        workerName: api.workerName,
      });
    }
    // With observability off the tracing keys are written empty, clearing stale values.
    const noToken = Redacted.make("");
    const tracing = observability && {
      url: observability.traces.otelTracesEndpoint,
      dataset: observability.traces.name,
      mobileToken: observability.mobileIngestToken.token,
      clientToken: observability.clientIngestToken.token,
    };
    yield* PublishClientConfig({
      url: api.url,
      mobileTracingUrl: tracing?.url ?? "",
      mobileTracingDataset: tracing?.dataset ?? "",
      mobileTracingToken: tracing?.mobileToken ?? noToken,
      clientTracingUrl: tracing?.url ?? "",
      clientTracingDataset: tracing?.dataset ?? "",
      clientTracingToken: tracing?.clientToken ?? noToken,
      tokenDigest: tracing
        ? Output.map(Output.all(tracing.mobileToken, tracing.clientToken), tokenDigest)
        : tokenDigest([noToken, noToken]),
    });

    return {
      databaseName: db?.database.name ?? "external",
      databaseBranchName: db ? (db.branch?.name ?? "main") : "external",
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      ...(observability && {
        mobileTracingUrl: observability.traces.otelTracesEndpoint,
        mobileTracingDataset: observability.traces.name,
        mobileTracingToken: observability.mobileIngestToken.token,
        clientTracingUrl: observability.traces.otelTracesEndpoint,
        clientTracingDataset: observability.traces.name,
        clientTracingToken: observability.clientIngestToken.token,
        mobileLogsDataset: observability.mobileLogs.name,
        mobileMetricsDataset: observability.mobileMetrics.name,
        mobileSourceMapsBucket: observability.mobileSourceMaps.bucketName,
      }),
      // The MOBILE_SOURCEMAPS_R2 secret for GitHub Actions and EAS Build.
      ...(mobileSourceMapsUploadCredentials && { mobileSourceMapsUploadCredentials }),
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
