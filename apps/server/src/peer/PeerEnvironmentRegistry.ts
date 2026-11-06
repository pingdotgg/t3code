import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type PeerLinkError,
  OpenShellWorkerClass,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { peerOrigin } from "./PeerLinks.ts";

const PeerHttpApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .annotateMerge(EnvironmentHttpApi.annotations);

/** How long a peer's descriptor may take before an address counts as unreachable. */
const probeTimeout = (origin: string) =>
  isLocalLoopbackHost(new URL(origin).hostname) ? Duration.seconds(3) : Duration.seconds(10);

/**
 * Scopes a delegation session asks for: the narrowest set that launches,
 * follows and steers threads on the peer; the peer may grant narrower.
 * OPEN-QUESTION (spec section 5.2, lanes 2 and 7): final scope set.
 */
const DelegationSessionScopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
] as const;

const OPENSHELL_FLEET_OFF =
  "OpenShell fleet management is off on this machine. Turn it on in Settings → Labs.";

export type PeerEnvironmentRole = "managing" | "worker";

export interface PeerEnvironmentSession {
  /** The scopes the peer actually granted, which never exceed the ask. */
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: DateTime.Utc;
}

/** One registered peer t3 instance: the managing instance or a worker. */
export interface PeerEnvironment {
  readonly environmentId: EnvironmentId;
  readonly role: PeerEnvironmentRole;
  readonly label: string;
  readonly urls: ReadonlyArray<string>;
  /** Workers only; the managing instance has none. */
  readonly workerClass: OpenShellWorkerClass | null;
  readonly registeredAt: DateTime.Utc;
  /** Present once a bootstrap exchange paired this environment with the peer. */
  readonly session: Option.Option<PeerEnvironmentSession>;
  readonly lastError: string | null;
}

/** A delegation session ready to call the peer's bridge with. */
export interface ResolvedPeerSession {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The first registered address, which pairing proved answers as this peer. */
  readonly url: string;
  readonly token: string;
}

export class PeerEnvironmentRegistryError extends Schema.TaggedError<PeerEnvironmentRegistryError>()(
  "PeerEnvironmentRegistryError",
  {
    reason: Schema.Literals([
      "storage",
      "disabled",
      "unknown_peer",
      "self",
      "unreachable",
      "not_paired",
      "exchange_rejected",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isRegistryError = Schema.is(PeerEnvironmentRegistryError);

/** Fails with a fixed storage error that keeps its cause; the log gets the details. */
const failStorage = (cause: unknown) =>
  Effect.logWarning("Fleet peer environment storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new PeerEnvironmentRegistryError({
          reason: "storage",
          message:
            "The fleet peer registry could not be read or saved here. The server log has details.",
          cause,
        }),
      ),
    ),
  );

const decodeUrls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUrls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeWorkerClass = Schema.decodeUnknownEffect(Schema.NullOr(OpenShellWorkerClass));
const decodeScopes = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeScopes = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** A peer address that may receive a credential, or why it may not. */
const originOf = (url: string): Effect.Effect<string, PeerEnvironmentRegistryError> =>
  // peerOrigin's returns infer as a union of effects; one assertion narrows the
  // error, which is only ever a PeerLinkError.
  Effect.suspend(() => peerOrigin(url) as Effect.Effect<string, PeerLinkError>).pipe(
    Effect.mapError(
      (error) =>
        new PeerEnvironmentRegistryError({ reason: "unreachable", message: error.message }),
    ),
  );

/**
 * Registry of peer t3 instances this environment knows as a fleet: itself as
 * the managing instance plus the workers it delegates to. Pairing trades a
 * peer's one-time bootstrap credential for a delegation session; the token
 * lives in the server secret store, the row keeps the rest.
 */
export class PeerEnvironmentRegistry extends Context.Service<
  PeerEnvironmentRegistry,
  {
    /** Whether the OpenShell fleet beta (Settings → Labs) is on here. */
    readonly enabled: Effect.Effect<boolean>;
    readonly register: (input: {
      readonly environmentId: EnvironmentId;
      readonly role: PeerEnvironmentRole;
      readonly label: string;
      readonly urls: ReadonlyArray<string>;
      readonly workerClass?: OpenShellWorkerClass;
    }) => Effect.Effect<PeerEnvironment, PeerEnvironmentRegistryError>;
    /**
     * Forgets the peer here and removes its delegation session. The peer still
     * lists this environment's session until it is revoked there, like
     * unlinking a peer link.
     */
    readonly unregister: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<boolean, PeerEnvironmentRegistryError>;
    readonly list: Effect.Effect<ReadonlyArray<PeerEnvironment>, PeerEnvironmentRegistryError>;
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PeerEnvironment>, PeerEnvironmentRegistryError>;
    /**
     * Pairing bootstrap exchange: the peer's one-time bootstrap credential
     * becomes a delegation session scoped to `DelegationSessionScopes`. The
     * credential goes only to an address whose descriptor proves it is the
     * registered peer. Re-pairing replaces the stored token.
     */
    readonly exchangeBootstrap: (input: {
      readonly environmentId: EnvironmentId;
      readonly bootstrapCredential: string;
    }) => Effect.Effect<PeerEnvironment, PeerEnvironmentRegistryError>;
    /** The stored delegation session, ready to call the peer's bridge with. */
    readonly resolveSession: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ResolvedPeerSession, PeerEnvironmentRegistryError>;
  }
>()("t3/peer/PeerEnvironmentRegistry") {}

interface PeerEnvironmentRow {
  readonly environment_id: string;
  readonly role: string;
  readonly label: string;
  readonly urls_json: string;
  readonly worker_class: string | null;
  readonly secret_name: string | null;
  readonly session_scopes_json: string | null;
  readonly session_expires_at: string | null;
  readonly registered_at: string;
  readonly last_error: string | null;
}

const toPeerEnvironment = Effect.fn("PeerEnvironmentRegistry.toPeerEnvironment")(function* (
  row: PeerEnvironmentRow,
) {
  const session =
    row.secret_name !== null && row.session_scopes_json !== null && row.session_expires_at !== null
      ? Option.some({
          scopes: yield* decodeScopes(row.session_scopes_json).pipe(Effect.catch(failStorage)),
          expiresAt: DateTime.makeUnsafe(row.session_expires_at),
        } satisfies PeerEnvironmentSession)
      : Option.none<PeerEnvironmentSession>();
  return {
    environmentId: EnvironmentId.make(row.environment_id),
    role: row.role as PeerEnvironmentRole,
    label: row.label,
    urls: yield* decodeUrls(row.urls_json).pipe(Effect.catch(failStorage)),
    workerClass: yield* decodeWorkerClass(row.worker_class).pipe(Effect.catch(failStorage)),
    registeredAt: DateTime.makeUnsafe(row.registered_at),
    session,
    lastError: row.last_error,
  } satisfies PeerEnvironment;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.openshellEnabled),
    Effect.orElseSucceed(() => false),
  );

  /** A fresh slot name for one peer's delegation session token; the row records it. */
  const newSecretName = random.randomBytes(16).pipe(
    Effect.map((bytes) => `fleet-peer-${Hex.encode(bytes)}`),
    Effect.orDie,
  );

  // Only the origin `peerOrigin` checked may receive a bootstrap credential or
  // token: a redirect could forward them anywhere, including plain http.
  const peerHttpClient = HttpClient.transform(httpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const clientFor = (origin: string) =>
    HttpApiClient.make(PeerHttpApi, { baseUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, peerHttpClient),
    );

  /** The environment answering at `origin`, or nothing when it does not answer as T3 Code. */
  const describe = (origin: string) =>
    clientFor(origin).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      Effect.timeout(probeTimeout(origin)),
      Effect.option,
    );

  const readRows = sql<PeerEnvironmentRow>`
    SELECT * FROM fleet_peer_environments ORDER BY label, environment_id
  `.pipe(NodeSqliteClient.readOnly, Effect.catch(failStorage));

  const readRow = (environmentId: EnvironmentId) =>
    sql<PeerEnvironmentRow>`
      SELECT * FROM fleet_peer_environments WHERE environment_id = ${environmentId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.catch(failStorage),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const requireRow = (environmentId: EnvironmentId) =>
    readRow(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new PeerEnvironmentRegistryError({
                reason: "unknown_peer",
                message: `${environmentId} is not a registered fleet peer.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const selfEnvironmentId = environment.getEnvironmentId.pipe(
    Effect.orElseSucceed(() => EnvironmentId.make("environment-self")),
  );

  const register: PeerEnvironmentRegistry["Service"]["register"] = Effect.fn(
    "PeerEnvironmentRegistry.register",
  )(function* (input) {
    if (!(yield* enabled)) {
      return yield* new PeerEnvironmentRegistryError({
        reason: "disabled",
        message: OPENSHELL_FLEET_OFF,
      });
    }
    if (input.environmentId === (yield* selfEnvironmentId)) {
      return yield* new PeerEnvironmentRegistryError({
        reason: "self",
        message: "That environment is this one.",
      });
    }
    const urls = yield* Effect.forEach(input.urls, originOf);
    const now = yield* DateTime.now;
    yield* sql`
      INSERT INTO fleet_peer_environments (
        environment_id, role, label, urls_json, worker_class, secret_name,
        session_scopes_json, session_expires_at, registered_at, last_error
      ) VALUES (
        ${input.environmentId}, ${input.role}, ${input.label},
        ${yield* encodeUrls([...urls]).pipe(Effect.catch(failStorage))},
        ${input.workerClass ?? null}, NULL, NULL, NULL, ${DateTime.formatIso(now)}, NULL
      )
      ON CONFLICT (environment_id) DO UPDATE SET
        role = excluded.role,
        label = excluded.label,
        urls_json = excluded.urls_json,
        worker_class = excluded.worker_class,
        last_error = NULL
    `.pipe(Effect.catch(failStorage));
    return Option.getOrThrow(yield* get(input.environmentId));
  });

  const unregister: PeerEnvironmentRegistry["Service"]["unregister"] = Effect.fn(
    "PeerEnvironmentRegistry.unregister",
  )(function* (environmentId) {
    if (!(yield* enabled)) {
      return yield* new PeerEnvironmentRegistryError({
        reason: "disabled",
        message: OPENSHELL_FLEET_OFF,
      });
    }
    const deleted = yield* sql<{ secret_name: string | null }>`
      DELETE FROM fleet_peer_environments WHERE environment_id = ${environmentId}
      RETURNING secret_name
    `.pipe(Effect.catch(failStorage));
    for (const row of deleted) {
      if (row.secret_name !== null) {
        yield* secrets.remove(row.secret_name).pipe(Effect.catch(failStorage));
      }
    }
    return deleted.length > 0;
  });

  const list: PeerEnvironmentRegistry["Service"]["list"] = Effect.gen(function* () {
    const rows = yield* readRows;
    return yield* Effect.forEach(rows, toPeerEnvironment);
  });

  const get: PeerEnvironmentRegistry["Service"]["get"] = (environmentId) =>
    readRow(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => Effect.asSome(toPeerEnvironment(row)),
        }),
      ),
    );

  const exchangeBootstrap: PeerEnvironmentRegistry["Service"]["exchangeBootstrap"] = Effect.fn(
    "PeerEnvironmentRegistry.exchangeBootstrap",
  )(function* (input) {
    if (!(yield* enabled)) {
      return yield* new PeerEnvironmentRegistryError({
        reason: "disabled",
        message: OPENSHELL_FLEET_OFF,
      });
    }
    const row = yield* requireRow(input.environmentId);
    const urls = yield* decodeUrls(row.urls_json).pipe(Effect.catch(failStorage));
    // The credential goes only to an address whose descriptor proves it is
    // this peer, so a reused address never receives it.
    const checked = yield* Effect.forEach(
      urls,
      (url) =>
        Effect.gen(function* () {
          const origin = yield* originOf(url);
          return { origin, descriptor: yield* describe(origin) };
        }).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const answering = checked.flatMap((result) => {
      if (!Result.isSuccess(result) || Option.isNone(result.success.descriptor)) return [];
      const descriptor = result.success.descriptor.value;
      return descriptor.environmentId === input.environmentId
        ? [{ origin: result.success.origin, descriptor }]
        : [];
    });
    const found = answering[0];
    if (found === undefined) {
      return yield* new PeerEnvironmentRegistryError({
        reason: "unreachable",
        message: `${input.environmentId} did not answer as itself at ${urls.join(", ")}. No session was stored.`,
      });
    }
    const descriptor = found.descriptor as ExecutionEnvironmentDescriptor;
    const exchanged = yield* clientFor(found.origin).pipe(
      Effect.flatMap((client) =>
        client.auth.token({
          headers: {},
          payload: {
            grant_type: AuthTokenExchangeGrantType,
            subject_token: input.bootstrapCredential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            scope: [...DelegationSessionScopes].join(" "),
          },
        }),
      ),
      Effect.mapError((cause) =>
        isRegistryError(cause)
          ? cause
          : new PeerEnvironmentRegistryError({
              reason: "exchange_rejected",
              message: `${descriptor.label} refused the delegation session exchange. Check its pairing credential and try again.`,
              cause,
            }),
      ),
    );
    const granted = exchanged.scope.split(" ").filter((scope) => scope.length > 0);
    const missing = DelegationSessionScopes.filter((scope) => !granted.includes(scope));
    if (granted.length === 0 || missing.length > 0) {
      return yield* new PeerEnvironmentRegistryError({
        reason: "exchange_rejected",
        message: `${descriptor.label} granted a session without ${
          missing.length > 0 ? missing.join(", ") : "any delegated scope"
        }. Issue a pairing credential that carries them.`,
      });
    }
    const expiresAt = DateTime.add(yield* DateTime.now, { seconds: exchanged.expires_in });
    // The token goes under a name of its own before the row points at it, so
    // the row and its token are replaced together.
    const secretName = yield* newSecretName;
    yield* secrets
      .set(secretName, new TextEncoder().encode(exchanged.access_token))
      .pipe(Effect.catch(failStorage));
    const previous = yield* Effect.gen(function* () {
      yield* sql`
        UPDATE fleet_peer_environments
        SET secret_name = ${secretName}, session_scopes_json = ${yield* encodeScopes(granted).pipe(
          Effect.catch(failStorage),
        )},
            session_expires_at = ${DateTime.formatIso(expiresAt)}, label = ${descriptor.label},
            last_error = NULL
        WHERE environment_id = ${input.environmentId}
      `.pipe(Effect.catch(failStorage));
      return row;
    }).pipe(Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)));
    // Pairing again replaces the old token; a racing exchange may leave its
    // own behind, unused either way.
    if (previous.secret_name !== null && previous.secret_name !== secretName) {
      yield* secrets.remove(previous.secret_name).pipe(Effect.ignore);
    }
    return Option.getOrThrow(yield* get(input.environmentId));
  });

  const resolveSession: PeerEnvironmentRegistry["Service"]["resolveSession"] = Effect.fn(
    "PeerEnvironmentRegistry.resolveSession",
  )(function* (environmentId) {
    // Resolution stays available while the beta is off, so work already
    // running on a peer still finishes, like linked environments do.
    const row = yield* requireRow(environmentId);
    const peer = yield* toPeerEnvironment(row);
    if (Option.isNone(peer.session) || row.secret_name === null) {
      return yield* new PeerEnvironmentRegistryError({
        reason: "not_paired",
        message: `${environmentId} has no delegation session yet. Pair it with a bootstrap credential from the peer.`,
      });
    }
    const stored = yield* secrets.get(row.secret_name).pipe(Effect.catch(failStorage));
    if (Option.isNone(stored)) {
      return yield* new PeerEnvironmentRegistryError({
        reason: "unknown_peer",
        message: `The delegation session for ${peer.label} lost its credential. Pair it again.`,
      });
    }
    const url = peer.urls[0];
    if (url === undefined) {
      return yield* new PeerEnvironmentRegistryError({
        reason: "unreachable",
        message: `${peer.label} has no address to reach it at.`,
      });
    }
    return {
      environmentId: peer.environmentId,
      label: peer.label,
      url,
      token: new TextDecoder().decode(stored.value),
    };
  });

  return PeerEnvironmentRegistry.of({
    enabled,
    register,
    unregister,
    list,
    get,
    exchangeBootstrap,
    resolveSession,
  });
});

export const layer = Layer.effect(PeerEnvironmentRegistry, make);
