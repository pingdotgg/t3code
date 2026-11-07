import {
  EnvironmentHttpApi,
  EnvironmentId,
  LanGatewayError,
  type LanGatewayAddInput,
  type LanGatewayPeerAdvertisement,
  type LanGatewayPeerSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";

const PeerHttpApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .annotateMerge(EnvironmentHttpApi.annotations);

const LAN_GATEWAY_OFF = "LAN gateway is off on this machine. Turn it on in Settings → Labs.";

const probeTimeout = (origin: string) =>
  isLocalLoopbackHost(new URL(origin).hostname) ? Duration.seconds(3) : Duration.seconds(10);

interface LanGatewayPeerRow {
  readonly environment_id: string;
  readonly label: string;
  readonly http_base_url: string;
  readonly added_at: string;
}

const failStorage = (cause: unknown) =>
  Effect.logWarning("LAN gateway storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new LanGatewayError({
          reason: "storage",
          message: "LAN gateway peers could not be read or saved here. The server log has details.",
          cause,
        }),
      ),
    ),
  );

const toSummary = (row: LanGatewayPeerRow): LanGatewayPeerSummary => ({
  environmentId: EnvironmentId.make(row.environment_id),
  label: row.label,
  httpBaseUrl: row.http_base_url,
});

const toAdvertisement = (row: LanGatewayPeerRow): LanGatewayPeerAdvertisement => ({
  environmentId: EnvironmentId.make(row.environment_id),
  label: row.label,
});

/** Base URL of a private/loopback/tailnet peer, normalised to its origin. */
const peerOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(
      new LanGatewayError({
        reason: "unreachable",
        message: `${url} is not an http or https address.`,
      }),
    );
  }
  if (
    !isPrivateNetworkHost(parsed.hostname) &&
    !isTailnetHost(parsed.hostname) &&
    !isLocalLoopbackHost(parsed.hostname)
  ) {
    return Effect.fail(
      new LanGatewayError({
        reason: "not_private",
        message: `${url} is not on a private, loopback, or Tailscale network. Only those addresses can be gateway peers.`,
      }),
    );
  }
  return Effect.succeed(parsed.origin);
};

export class LanGateway extends Context.Service<
  LanGateway,
  {
    readonly list: Effect.Effect<ReadonlyArray<LanGatewayPeerSummary>, LanGatewayError>;
    readonly add: (
      input: LanGatewayAddInput,
    ) => Effect.Effect<LanGatewayPeerSummary, LanGatewayError>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<boolean, LanGatewayError>;
    readonly advertise: Effect.Effect<ReadonlyArray<LanGatewayPeerAdvertisement>>;
    /**
     * Emits whenever the advertised peer set may have changed (add/remove/settings).
     * Subscribe before reading a snapshot to retain changes before lazy stream startup.
     */
    readonly subscribeAdvertisementChanges: Effect.Effect<
      Stream.Stream<ReadonlyArray<LanGatewayPeerAdvertisement>>,
      never,
      Scope.Scope
    >;
    readonly resolveUpstream: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("t3/gateway/LanGateway") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const changesPubSub = yield* PubSub.unbounded<ReadonlyArray<LanGatewayPeerAdvertisement>>();
  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.lanGatewayEnabled),
    Effect.orElseSucceed(() => false),
  );

  const peerHttpClient = HttpClient.transform(httpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const clientFor = (origin: string) =>
    HttpApiClient.make(PeerHttpApi, { baseUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, peerHttpClient),
    );

  const describe = (origin: string) =>
    clientFor(origin).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      Effect.timeout(probeTimeout(origin)),
      Effect.option,
    );

  const readRows = sql<LanGatewayPeerRow>`
    SELECT * FROM lan_gateway_peers ORDER BY label, environment_id
  `.pipe(NodeSqliteClient.readOnly, Effect.catch(failStorage));

  const readRow = (environmentId: EnvironmentId) =>
    sql<LanGatewayPeerRow>`
      SELECT * FROM lan_gateway_peers WHERE environment_id = ${environmentId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.catch(failStorage),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const requireEnabled = Effect.gen(function* () {
    if (!(yield* enabled)) {
      return yield* new LanGatewayError({ reason: "disabled", message: LAN_GATEWAY_OFF });
    }
  });

  const list: LanGateway["Service"]["list"] = Effect.gen(function* () {
    yield* requireEnabled;
    return (yield* readRows).map(toSummary);
  }).pipe(Effect.withSpan("LanGateway.list"));

  const add: LanGateway["Service"]["add"] = Effect.fn("LanGateway.add")(function* (input) {
    yield* requireEnabled;
    const origin = yield* peerOrigin(input.url);
    const descriptor = yield* describe(origin);
    if (Option.isNone(descriptor)) {
      return yield* new LanGatewayError({
        reason: "not_a_t3_environment",
        message: `Nothing at ${origin} answered as a T3 Code environment.`,
      });
    }
    const peer = descriptor.value;
    const self = yield* environment.getDescriptor;
    if (peer.environmentId === self.environmentId) {
      return yield* new LanGatewayError({
        reason: "self",
        message: "That address is this environment.",
      });
    }
    const now = yield* DateTime.now;
    const summary: LanGatewayPeerSummary = {
      environmentId: peer.environmentId,
      label: peer.label,
      httpBaseUrl: origin,
    };
    yield* sql`
      INSERT INTO lan_gateway_peers (environment_id, label, http_base_url, added_at)
      VALUES (
        ${summary.environmentId},
        ${summary.label},
        ${summary.httpBaseUrl},
        ${DateTime.formatIso(now)}
      )
      ON CONFLICT (environment_id) DO UPDATE SET
        label = excluded.label,
        http_base_url = excluded.http_base_url,
        added_at = excluded.added_at
    `.pipe(Effect.catch(failStorage));
    return summary;
  });

  const remove: LanGateway["Service"]["remove"] = Effect.fn("LanGateway.remove")(
    function* (environmentId) {
      yield* requireEnabled;
      const deleted = yield* sql`
        DELETE FROM lan_gateway_peers WHERE environment_id = ${environmentId}
        RETURNING environment_id
      `.pipe(Effect.catch(failStorage));
      return deleted.length > 0;
    },
  );

  const advertise: LanGateway["Service"]["advertise"] = Effect.gen(function* () {
    if (!(yield* enabled)) return [];
    return yield* readRows.pipe(
      Effect.map((rows) => rows.map(toAdvertisement)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<LanGatewayPeerAdvertisement>),
    );
  }).pipe(Effect.withSpan("LanGateway.advertise"));

  const publishAdvertisement = advertise.pipe(
    Effect.flatMap((peers) => PubSub.publish(changesPubSub, peers)),
    Effect.asVoid,
  );

  const addAndPublish: LanGateway["Service"]["add"] = Effect.fn("LanGateway.add")(
    function* (input) {
      const summary = yield* add(input);
      yield* publishAdvertisement;
      return summary;
    },
  );

  const removeAndPublish: LanGateway["Service"]["remove"] = Effect.fn("LanGateway.remove")(
    function* (environmentId) {
      const removed = yield* remove(environmentId);
      if (removed) yield* publishAdvertisement;
      return removed;
    },
  );

  const resolveUpstream: LanGateway["Service"]["resolveUpstream"] = Effect.fn(
    "LanGateway.resolveUpstream",
  )(function* (environmentId) {
    if (!(yield* enabled)) return Option.none();
    return yield* readRow(environmentId).pipe(
      Effect.map(Option.map((row) => row.http_base_url)),
      Effect.orElseSucceed(() => Option.none()),
    );
  });

  return LanGateway.of({
    list,
    add: addAndPublish,
    remove: removeAndPublish,
    advertise,
    subscribeAdvertisementChanges: Effect.gen(function* () {
      const peerChanges = yield* PubSub.subscribe(changesPubSub);
      const settingsChanges = yield* serverSettings.subscribeChanges;
      return Stream.merge(
        Stream.fromSubscription(peerChanges),
        // Settings toggles change whether peers are advertised without touching the table.
        settingsChanges.pipe(Stream.mapEffect(() => advertise)),
      );
    }),
    resolveUpstream,
  });
});

export const layer = Layer.effect(LanGateway, make);
