// Owns each remote environment's preview proxy for the life of the app, not of a webview: the
// loopback listener, the grant and its renewal, consumer credentials, and revocation. Embedded
// partitions and an external Chromium are independent consumers of the same listener.
import type {
  DesktopRemotePreviewExternalAccess,
  DesktopRemotePreviewProxyConfigureInput,
  DesktopRemotePreviewProxyState,
  DesktopRemotePreviewProxyStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  REMOTE_PREVIEW_PROXY_GRANT_HEADER,
  REMOTE_PREVIEW_PROXY_RENEW_PATH,
  REMOTE_PREVIEW_PROXY_REVOKE_PATH,
} from "@t3tools/shared/remotePreviewProxy";
import type { Session } from "electron";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ElectronApp from "../electron/ElectronApp.ts";
import {
  type RemotePreviewProxyRoute,
  type RemotePreviewProxyServer,
  startRemotePreviewProxyServer,
} from "./RemotePreviewProxyServer.ts";

/** How long a credential handed to an external browser stays valid. */
export const EXTERNAL_ACCESS_TTL = Duration.hours(8);
const MIN_RENEW_LEAD = Duration.seconds(30);
const RENEW_RETRY = Duration.seconds(15);
const EMBEDDED_USER = "t3-embedded";
const EXTERNAL_USER = "t3-external";

export class RemotePreviewProxyStartError extends Schema.TaggedError<RemotePreviewProxyStartError>()(
  "RemotePreviewProxyStartError",
  { environmentId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to start the remote preview proxy for environment ${this.environmentId}.`;
  }
}

export class RemotePreviewProxySessionError extends Schema.TaggedError<RemotePreviewProxySessionError>()(
  "RemotePreviewProxySessionError",
  { environmentId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to route the preview session for environment ${this.environmentId} through its proxy.`;
  }
}

export class RemotePreviewProxyNotConfiguredError extends Schema.TaggedError<RemotePreviewProxyNotConfiguredError>()(
  "RemotePreviewProxyNotConfiguredError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Environment ${this.environmentId} has no active remote preview proxy.`;
  }
}

const RenewResponse = Schema.Struct({
  grant: Schema.String,
  expiresAt: Schema.String,
  ports: Schema.Array(Schema.Int),
});

interface Entry {
  readonly environmentId: EnvironmentId;
  readonly server: RemotePreviewProxyServer;
  readonly embeddedCredential: string;
  readonly sessions: Set<Session>;
  label: string;
  httpBaseUrl: string | null;
  route: RemotePreviewProxyRoute | null;
  state: DesktopRemotePreviewProxyState;
  expiresAt: number | null;
  /** Every grant this entry used, so revocation reaches tunnels opened before a re-issue. */
  readonly grants: Set<string>;
  readonly deniedPorts: Set<number>;
  external: { readonly credential: string; readonly expiresAt: number } | null;
}

export class RemotePreviewProxy extends Context.Service<
  RemotePreviewProxy,
  {
    /** Routes a preview partition through the environment's proxy. Fails closed until configured. */
    readonly attachSession: (
      environmentId: EnvironmentId,
      session: Session,
    ) => Effect.Effect<void, RemotePreviewProxyStartError | RemotePreviewProxySessionError>;
    readonly configure: (
      input: DesktopRemotePreviewProxyConfigureInput,
    ) => Effect.Effect<DesktopRemotePreviewProxyStatus, RemotePreviewProxyStartError>;
    readonly status: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<DesktopRemotePreviewProxyStatus | null>;
    readonly statuses: () => Effect.Effect<ReadonlyArray<DesktopRemotePreviewProxyStatus>>;
    readonly issueExternalAccess: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<DesktopRemotePreviewExternalAccess, RemotePreviewProxyNotConfiguredError>;
    readonly revokeExternalAccess: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly revoke: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /** The embedded consumer's `user:password` for a listener port, for Electron's login event. */
    readonly embeddedCredentialForPort: (port: number) => string | null;
    readonly subscribe: (
      listener: (status: DesktopRemotePreviewProxyStatus) => void,
    ) => Effect.Effect<() => void>;
  }
>()("@t3tools/desktop/preview/RemotePreviewProxy") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  const httpClient = yield* HttpClient.HttpClient;
  const renewals = yield* FiberMap.make<EnvironmentId>();
  const externalExpirations = yield* FiberMap.make<EnvironmentId>();
  const entries = new Map<EnvironmentId, Entry>();
  const listeners = new Set<(status: DesktopRemotePreviewProxyStatus) => void>();
  const scope = yield* Effect.scope;

  const toStatus = (entry: Entry): DesktopRemotePreviewProxyStatus => ({
    environmentId: entry.environmentId,
    state: entry.state,
    ports: [...(entry.route?.ports ?? [])].toSorted((a, b) => a - b),
    deniedPorts: [...entry.deniedPorts].toSorted((a, b) => a - b),
    expiresAt: entry.expiresAt,
    externalAccess: entry.external === null ? null : { expiresAt: entry.external.expiresAt },
  });
  const publish = (entry: Entry) => {
    const status = toStatus(entry);
    for (const listener of listeners) listener(status);
  };

  const randomSecret = crypto.randomBytes(24).pipe(
    Effect.orDie,
    Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
  );

  const ensureEntry = Effect.fn("RemotePreviewProxy.ensureEntry")(function* (
    environmentId: EnvironmentId,
  ) {
    const existing = entries.get(environmentId);
    if (existing) return existing;
    const embeddedCredential = `${EMBEDDED_USER}:${yield* randomSecret}`;
    let entry: Entry | undefined;
    const server = yield* Effect.tryPromise({
      try: () =>
        startRemotePreviewProxyServer({
          label: () => entry?.label ?? "the remote environment",
          state: () => {
            if (entry && entry.state === "ready" && entry.route !== null) {
              return { _tag: "Ready", route: entry.route } as const;
            }
            const reason =
              entry === undefined || entry.state === "ready" ? "not-configured" : entry.state;
            return { _tag: "Unavailable", reason } as const;
          },
          credentials: () => {
            if (!entry) return [];
            const now = clock.currentTimeMillisUnsafe();
            return entry.external !== null && entry.external.expiresAt > now
              ? [entry.embeddedCredential, entry.external.credential]
              : [entry.embeddedCredential];
          },
          onDenied: (port) => {
            if (!entry || entry.deniedPorts.has(port)) return;
            entry.deniedPorts.add(port);
            publish(entry);
          },
          onGrantRejected: (grant) => {
            if (!entry || entry.route?.grant !== grant) return;
            entry.state = "expired";
            publish(entry);
          },
        }),
      catch: (cause) => new RemotePreviewProxyStartError({ environmentId, cause }),
    });
    // The listener lives until the app exits; partitions keep pointing at it to stay fail-closed.
    yield* Scope.addFinalizer(
      scope,
      Effect.promise(() => server.close()),
    );
    entry = {
      environmentId,
      server,
      embeddedCredential,
      sessions: new Set(),
      label: "the remote environment",
      httpBaseUrl: null,
      route: null,
      state: "not-configured",
      expiresAt: null,
      grants: new Set(),
      deniedPorts: new Set(),
      external: null,
    };
    entries.set(environmentId, entry);
    return entry;
  });

  const postGrant = (entry: Entry, path: string, grant: string) =>
    httpClient.execute(
      HttpClientRequest.post(new URL(path, entry.httpBaseUrl ?? "").toString()).pipe(
        HttpClientRequest.setHeader(REMOTE_PREVIEW_PROXY_GRANT_HEADER, grant),
      ),
    );

  const markExpired = (entry: Entry) =>
    Effect.sync(() => {
      entry.state = "expired";
      publish(entry);
    });

  // Renewal never resets connections: a failure leaves loaded pages and open sockets alone.
  const renewLoop = Effect.fn("RemotePreviewProxy.renewLoop")(function* (entry: Entry) {
    while (entry.state === "ready" && entry.route !== null && entry.expiresAt !== null) {
      const now = yield* Clock.currentTimeMillis;
      const remaining = entry.expiresAt - now;
      if (remaining <= 0) return yield* markExpired(entry);
      const lead = Math.max(Duration.toMillis(MIN_RENEW_LEAD), remaining / 3);
      yield* Effect.sleep(Duration.millis(Math.max(0, remaining - lead)));
      const route = entry.route;
      const response = yield* postGrant(entry, REMOTE_PREVIEW_PROXY_RENEW_PATH, route.grant).pipe(
        Effect.option,
      );
      if (entry.route !== route) continue;
      if (Option.isSome(response) && response.value.status === 401) {
        return yield* markExpired(entry);
      }
      const renewed =
        Option.isSome(response) && response.value.status === 200
          ? yield* HttpClientResponse.schemaBodyJson(RenewResponse)(response.value).pipe(
              Effect.option,
            )
          : Option.none();
      if (Option.isNone(renewed)) {
        const after = yield* Clock.currentTimeMillis;
        if (entry.expiresAt <= after) return yield* markExpired(entry);
        yield* Effect.sleep(
          Duration.millis(Math.min(Duration.toMillis(RENEW_RETRY), entry.expiresAt - after)),
        );
        continue;
      }
      entry.route = {
        httpBaseUrl: route.httpBaseUrl,
        grant: renewed.value.grant,
        ports: new Set(renewed.value.ports),
      };
      // A renewal keeps the grant's identity on the environment; revoking the newest suffices.
      entry.grants.delete(route.grant);
      entry.grants.add(renewed.value.grant);
      entry.expiresAt = Date.parse(renewed.value.expiresAt);
      publish(entry);
    }
  });

  const configure = Effect.fn("RemotePreviewProxy.configure")(function* (
    input: DesktopRemotePreviewProxyConfigureInput,
  ) {
    const entry = yield* ensureEntry(input.environmentId);
    entry.label = input.label;
    entry.httpBaseUrl = input.httpBaseUrl;
    entry.route = {
      httpBaseUrl: input.httpBaseUrl,
      grant: input.grant,
      ports: new Set(input.ports),
    };
    entry.grants.add(input.grant);
    entry.expiresAt = input.expiresAt;
    entry.state = "ready";
    for (const port of input.ports) entry.deniedPorts.delete(port);
    yield* FiberMap.run(renewals, input.environmentId, renewLoop(entry));
    publish(entry);
    return toStatus(entry);
  });

  const revoke = Effect.fn("RemotePreviewProxy.revoke")(function* (environmentId: EnvironmentId) {
    const entry = entries.get(environmentId);
    if (!entry) return;
    yield* FiberMap.remove(renewals, environmentId);
    yield* FiberMap.remove(externalExpirations, environmentId);
    const grants = [...entry.grants];
    entry.grants.clear();
    entry.route = null;
    entry.expiresAt = null;
    entry.external = null;
    entry.state = "revoked";
    entry.server.resetConnections();
    yield* Effect.forEach(
      entry.sessions,
      (session) => Effect.promise(() => session.closeAllConnections()).pipe(Effect.ignore),
      { discard: true },
    );
    publish(entry);
    // Best effort: the environment also drops these when the issuing session signs out.
    yield* Effect.forEach(
      grants,
      (grant) => postGrant(entry, REMOTE_PREVIEW_PROXY_REVOKE_PATH, grant).pipe(Effect.ignore),
      { concurrency: "unbounded", discard: true },
    );
  });

  return RemotePreviewProxy.of({
    attachSession: Effect.fn("RemotePreviewProxy.attachSession")(
      function* (environmentId, session) {
        const entry = yield* ensureEntry(environmentId);
        if (entry.sessions.has(session)) return;
        yield* Effect.tryPromise({
          try: async () => {
            await session.setProxy({
              mode: "fixed_servers",
              proxyRules: `http://127.0.0.1:${entry.server.port}`,
              // Chromium bypasses proxies for loopback unless told otherwise.
              proxyBypassRules: "<-loopback>",
            });
            await session.closeAllConnections();
          },
          catch: (cause) => new RemotePreviewProxySessionError({ environmentId, cause }),
        });
        entry.sessions.add(session);
      },
    ),
    configure,
    status: Effect.fn("RemotePreviewProxy.status")((environmentId) =>
      Effect.sync(() => {
        const entry = entries.get(environmentId);
        return entry ? toStatus(entry) : null;
      }),
    ),
    statuses: Effect.fn("RemotePreviewProxy.statuses")(() =>
      Effect.sync(() => [...entries.values()].map(toStatus)),
    ),
    issueExternalAccess: Effect.fn("RemotePreviewProxy.issueExternalAccess")(
      function* (environmentId) {
        const entry = entries.get(environmentId);
        if (!entry || entry.state !== "ready") {
          return yield* new RemotePreviewProxyNotConfiguredError({ environmentId });
        }
        const password = yield* randomSecret;
        const expiresAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(EXTERNAL_ACCESS_TTL);
        // One external consumer at a time: a new credential replaces the old one.
        if (entry.external !== null) entry.server.closeTunnelsFor(entry.external.credential);
        const external = { credential: `${EXTERNAL_USER}:${password}`, expiresAt };
        entry.external = external;
        yield* FiberMap.run(
          externalExpirations,
          environmentId,
          Effect.gen(function* () {
            yield* Effect.sleep(EXTERNAL_ACCESS_TTL);
            if (entry.external !== external) return;
            entry.server.closeTunnelsFor(external.credential);
            entry.external = null;
            publish(entry);
          }),
        );
        publish(entry);
        return {
          proxyServer: `http://127.0.0.1:${entry.server.port}`,
          username: EXTERNAL_USER,
          password,
          expiresAt,
        };
      },
    ),
    revokeExternalAccess: Effect.fn("RemotePreviewProxy.revokeExternalAccess")((environmentId) =>
      Effect.sync(() => {
        const entry = entries.get(environmentId);
        if (!entry || entry.external === null) return;
        // Tunnels already open through the old credential end with it; embedded ones stay.
        entry.server.closeTunnelsFor(entry.external.credential);
        entry.external = null;
        publish(entry);
      }),
    ),
    revoke,
    embeddedCredentialForPort: (port) => {
      for (const entry of entries.values()) {
        if (entry.server.port === port) return entry.embeddedCredential;
      }
      return null;
    },
    subscribe: Effect.fn("RemotePreviewProxy.subscribe")((listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    ),
  });
});

export const layer = Layer.effect(RemotePreviewProxy, make);

/** Answers Chromium's proxy authentication for embedded preview partitions. */
export const layerElectronProxyAuth = Layer.effectDiscard(
  Effect.gen(function* () {
    const proxy = yield* RemotePreviewProxy;
    const electronApp = yield* ElectronApp.ElectronApp;
    yield* electronApp.on(
      "login",
      (
        event: { preventDefault: () => void },
        _webContents: unknown,
        _details: unknown,
        authInfo: { readonly isProxy: boolean; readonly host: string; readonly port: number },
        callback: (username?: string, password?: string) => void,
      ) => {
        if (!authInfo.isProxy || authInfo.host !== "127.0.0.1") return;
        const credential = proxy.embeddedCredentialForPort(authInfo.port);
        if (credential === null) return;
        event.preventDefault();
        const separator = credential.indexOf(":");
        callback(credential.slice(0, separator), credential.slice(separator + 1));
      },
    );
  }),
);
