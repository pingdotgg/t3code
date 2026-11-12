import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { managedEndpointTunnelNamePrefix } from "./deploymentConfig.ts";
import { isPreviewStage, previewSweepTargets } from "./previewStages.ts";

// Managed endpoint tunnels and their CNAMEs are created by the Worker at
// runtime, so Alchemy never tracks them and `alchemy destroy` leaves them behind.
// This resource exists only so its delete runs during a preview stage's destroy.

export interface PreviewTunnelSweepProps {
  readonly stage: string;
  readonly tunnelZoneName: string;
  // Depending on the Worker makes Alchemy delete this sweep before the Worker,
  // because dependents go first. A live Worker could create a tunnel during
  // that gap; the relay accepts that window.
  readonly workerName: string;
}

export interface PreviewTunnelSweepAttributes {
  readonly stage: string;
  readonly tunnelZoneName: string;
  readonly workerName: string;
}

export type PreviewTunnelSweep = Resource<
  "T3CodeRelay.PreviewTunnelSweep",
  PreviewTunnelSweepProps,
  PreviewTunnelSweepAttributes
>;

export const PreviewTunnelSweep = Resource<PreviewTunnelSweep>("T3CodeRelay.PreviewTunnelSweep");

const API = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 100;

const TunnelPage = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
});
const ZonePage = Schema.Struct({ result: Schema.Array(Schema.Struct({ id: Schema.String })) });
const DnsRecordPage = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      content: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const collectPages = Effect.fn("PreviewTunnelSweep.collectPages")(function* <T, E, R>(
  fetchPage: (page: number) => Effect.Effect<ReadonlyArray<T>, E, R>,
) {
  const items: Array<T> = [];
  for (let page = 1; ; page += 1) {
    const batch = yield* fetchPage(page);
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
});

// Idempotent: a second run lists nothing and deletes nothing.
export const sweepPreviewStage = Effect.fn("PreviewTunnelSweep.sweep")(function* (input: {
  readonly stage: string;
  readonly tunnelZoneName: string;
  readonly accountId: string;
  readonly token: Redacted.Redacted<string>;
}) {
  const client = yield* HttpClient.HttpClient;
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      HttpClientRequest.bearerToken(Redacted.value(input.token)),
      client.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  const getJson = <A, I>(url: string, params: Record<string, string>, schema: Schema.Codec<A, I>) =>
    send(HttpClientRequest.get(url, { urlParams: params })).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    );
  // A 404 means the object is already gone, which is the outcome teardown wants.
  // Any other failure, including 429, fails the step so the next run retries it.
  const remove = (url: string) =>
    HttpClientRequest.make("DELETE")(url).pipe(
      HttpClientRequest.bearerToken(Redacted.value(input.token)),
      client.execute,
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.void
          : HttpClientResponse.filterStatusOk(response).pipe(Effect.asVoid),
      ),
    );

  const listedTunnels = yield* collectPages((page) =>
    getJson(
      `${API}/accounts/${input.accountId}/cfd_tunnel`,
      {
        is_deleted: "false",
        include_prefix: managedEndpointTunnelNamePrefix(input.stage),
        per_page: String(PAGE_SIZE),
        page: String(page),
      },
      TunnelPage,
    ).pipe(Effect.map((body) => body.result)),
  );

  // No tunnels means nothing to clean, so the zone is not needed and may be gone.
  if (listedTunnels.length === 0) return;

  const zone = yield* getJson(`${API}/zones`, { name: input.tunnelZoneName }, ZonePage);
  const zoneId = zone.result[0]?.id;
  // Without the zone there are no CNAMEs to remove, but the tunnels still must go.
  const listedRecords =
    zoneId === undefined
      ? []
      : yield* collectPages((page) =>
          getJson(
            `${API}/zones/${zoneId}/dns_records`,
            { type: "CNAME", per_page: String(PAGE_SIZE), page: String(page) },
            DnsRecordPage,
          ).pipe(Effect.map((body) => body.result)),
        );

  const targets = previewSweepTargets({
    stage: input.stage,
    tunnelZoneName: input.tunnelZoneName,
    tunnels: listedTunnels,
    records: listedRecords,
  });

  // Records first, so no hostname points at a tunnel that is about to vanish.
  if (zoneId !== undefined) {
    for (const record of targets.records) {
      yield* remove(`${API}/zones/${zoneId}/dns_records/${record.id}`);
    }
  }
  // Cloudflare refuses to delete a tunnel that still has connectors attached.
  for (const tunnel of targets.tunnels) {
    yield* remove(`${API}/accounts/${input.accountId}/cfd_tunnel/${tunnel.id}/connections`);
    yield* remove(`${API}/accounts/${input.accountId}/cfd_tunnel/${tunnel.id}`);
  }
});

export const PreviewTunnelSweepProvider = () =>
  Provider.succeed(
    PreviewTunnelSweep,
    PreviewTunnelSweep.Provider.of({
      reconcile: ({ news }) =>
        Effect.succeed({
          stage: news.stage,
          tunnelZoneName: news.tunnelZoneName,
          workerName: news.workerName,
        }),
      // Nothing in Cloudflare is created for this resource, so there is nothing to list.
      list: () => Effect.succeed([]),
      delete: Effect.fn(function* ({ output }) {
        // The sweep runs only on preview stages. This guard keeps a mistaken
        // stage from reaching the production relay's tunnels.
        if (!isPreviewStage(output.stage)) {
          return yield* Effect.die(`Refusing to sweep non-preview stage '${output.stage}'`);
        }
        // Read from the environment, not the Cloudflare service, so the provider
        // needs no extra service in its layer. CI sets both for the destroy step.
        const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
        const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
        yield* sweepPreviewStage({
          stage: output.stage,
          tunnelZoneName: output.tunnelZoneName,
          accountId,
          token,
        }).pipe(Effect.provide(FetchHttpClient.layer));
      }),
    }),
  );
