import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "alchemy/Output";
import * as Planetscale from "alchemy/Planetscale";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { PlanetscaleDatabase, RelayHyperdrive } from "./src/db.ts";
import Api from "./src/worker.ts";
import { CloudMintKeyPairProvider } from "./src/infra/CloudMintKeyPair.ts";
import { ImportedCloudflareZoneProvider } from "./src/infra/ImportedCloudflareZone.ts";
import {
  MANAGED_ENDPOINT_ZONE,
  RELAY_PUBLIC_SUBDOMAIN,
  relayWorkerDomainDnsTokenPolicies,
} from "./src/infra/ManagedEndpointStackConfig.ts";
import { WorkerCustomDomain, WorkerCustomDomainProvider } from "./src/infra/WorkerCustomDomain.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
      FetchHttpClient.layer,
      CloudMintKeyPairProvider(),
      ImportedCloudflareZoneProvider(),
      WorkerCustomDomainProvider(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* PlanetscaleDatabase;
    const hyperdrive = yield* RelayHyperdrive;
    const api = yield* Api;
    const relayWorkerDomainDnsToken = yield* Cloudflare.AccountApiToken(
      "RelayWorkerDomainDnsToken",
      {
        name: "t3-code-relay-worker-domain-dns",
        policies: relayWorkerDomainDnsTokenPolicies({
          zoneId: MANAGED_ENDPOINT_ZONE.zoneId,
        }),
      },
    );
    const relayDomain = yield* WorkerCustomDomain("RelayWorkerDomain", {
      zoneId: MANAGED_ENDPOINT_ZONE.zoneId,
      workerName: api.workerName,
      subdomain: RELAY_PUBLIC_SUBDOMAIN,
      dnsApiToken: relayWorkerDomainDnsToken.value,
    });

    return {
      databaseName: db.database.name,
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: Output.interpolate`https://${relayDomain.hostname}`,
    };
  }),
);
