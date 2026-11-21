import { resolveRemoteWebSocketConnectionUrl } from "@lathe/client-runtime/authorization";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
} from "@lathe/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@lathe/client-runtime/environment";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@lathe/client-runtime/platform";
import { RpcSessionFactory, subscribeSessionShell } from "@lathe/client-runtime/rpc";
import { applyShellStreamEvent } from "@lathe/client-runtime/state/shell";
import {
  type AuthClientPresentationMetadata,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
} from "@lathe/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";

import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import type { MenuBarEnvironment } from "./menuBarSummary.ts";
import { menuBarRemoteSources, type MenuBarRemoteSource } from "./menuBarSources.ts";

type MenuBarSource = MenuBarRemoteSource | { readonly _tag: "local"; readonly key: "local" };
type ConnectableSource = Exclude<MenuBarSource, { readonly _tag: "unsupported" }>;

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
// One dropped socket is routine; a few in a row means the menu should stop pretending.
const FAILURES_BEFORE_UNAVAILABLE = 3;

const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectionCatalogDocument));

class MenuBarConnectError extends Schema.TaggedError<MenuBarConnectError>()("MenuBarConnectError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function failureDetail(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

/**
 * Follows every saved environment's shell stream from the main process, so the menu bar stays
 * live with no window open. Runs until its scope closes.
 */
export const startMenuBarFeed = Effect.fn("desktop.menuBar.startFeed")(function* () {
  const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const httpClient = yield* HttpClient.HttpClient;
  const { appVersion } = yield* DesktopEnvironment.DesktopEnvironment;
  const sessions = yield* RpcSessionFactory.make();
  const clientMetadata: AuthClientPresentationMetadata = {
    label: "Lathe menu bar",
    deviceType: "desktop",
    os: "macOS",
    surface: "desktop",
    appVersion,
  };

  const environments = yield* SubscriptionRef.make<ReadonlyMap<string, MenuBarEnvironment>>(
    new Map(),
  );
  const publish = (key: string, environment: MenuBarEnvironment | null) =>
    SubscriptionRef.update(environments, (current) => {
      const next = new Map(current);
      if (environment === null) next.delete(key);
      else next.set(key, environment);
      return next;
    });

  const endpoint = Effect.fn("desktop.menuBar.endpoint")(function* (source: ConnectableSource) {
    switch (source._tag) {
      case "local": {
        const instance = yield* pool.primary;
        const config = yield* instance.currentConfig;
        if (Option.isNone(config) || Option.isSome(config.value.preflightFailure)) {
          return yield* new MenuBarConnectError({ detail: "The local server is not running." });
        }
        return {
          httpBaseUrl: config.value.httpBaseUrl.href,
          wsBaseUrl: toWebSocketBaseUrl(config.value.httpBaseUrl),
          token: yield* localAuth.getBearerToken,
        };
      }
      case "bearer":
        return {
          httpBaseUrl: source.httpBaseUrl,
          wsBaseUrl: source.wsBaseUrl,
          token: source.token,
        };
      case "ssh": {
        // Reuses the window's tunnel when one is up, and never mints a pairing token.
        const bootstrap = yield* ssh.ensureEnvironment(source.target, { issuePairingToken: false });
        return {
          httpBaseUrl: bootstrap.httpBaseUrl,
          wsBaseUrl: bootstrap.wsBaseUrl,
          token: source.token,
        };
      }
    }
  });

  const prepare = Effect.fn("desktop.menuBar.prepare")(
    function* (source: ConnectableSource) {
      const { httpBaseUrl, wsBaseUrl, token } = yield* endpoint(source);
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl });
      if (source._tag !== "local" && descriptor.environmentId !== source.environmentId) {
        return yield* new MenuBarConnectError({
          detail: `${source.label} now answers as a different environment.`,
        });
      }
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        httpBaseUrl,
        wsBaseUrl,
        bearerToken: token,
        clientMetadata,
        connectionMethod: source._tag === "ssh" ? "ssh" : "direct",
      });
      const base = { environmentId: descriptor.environmentId, label: descriptor.label };
      const target =
        source._tag === "local"
          ? new PrimaryConnectionTarget({ ...base, httpBaseUrl, wsBaseUrl })
          : source._tag === "ssh"
            ? new SshConnectionTarget({ ...base, connectionId: source.key })
            : new BearerConnectionTarget({ ...base, connectionId: source.key });
      return {
        ...base,
        label: source._tag === "local" ? descriptor.label : source.label,
        httpBaseUrl,
        socketUrl,
        httpAuthorization: { _tag: "Bearer", token },
        target,
      } satisfies PreparedConnection;
    },
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );

  const follow = (source: ConnectableSource, onLive: (environmentId: EnvironmentId) => void) =>
    Effect.scoped(
      Effect.gen(function* () {
        const prepared = yield* prepare(source);
        const session = yield* sessions.connect(prepared);
        const config = yield* session.initialConfig;
        const omitIdleSubagents = config.shellThreadFamilies === true;
        const input = {
          ...(omitIdleSubagents ? { omitIdleSubagents: true as const } : {}),
          ...(omitIdleSubagents && config.shellOlderSettled === true
            ? { omitOlderSettled: true as const }
            : {}),
        };
        let snapshot: OrchestrationV2ShellSnapshot | null = null;
        yield* subscribeSessionShell(session, input).pipe(
          Stream.runForEach((item) => {
            // Only a subscriber that asked for the HTTP snapshot fallback gets snapshot-required.
            if (item.kind === "synchronized" || item.kind === "snapshot-required") {
              return Effect.void;
            }
            if (item.kind === "snapshot") {
              snapshot = item.snapshot;
              onLive(prepared.environmentId);
            } else if (snapshot !== null) {
              snapshot = applyShellStreamEvent(snapshot, item);
            }
            if (snapshot === null) return Effect.void;
            return publish(source.key, {
              environmentId: prepared.environmentId,
              label: prepared.label,
              status: "live",
              projects: snapshot.projects,
              threads: snapshot.threads,
            });
          }),
          Effect.raceFirst(session.closed),
        );
      }),
    );

  const supervise = Effect.fn("desktop.menuBar.supervise")(function* (source: ConnectableSource) {
    let failures = 0;
    let environmentId = source._tag === "local" ? null : source.environmentId;
    const label = source._tag === "local" ? "This Mac" : source.label;
    if (environmentId !== null)
      yield* publish(source.key, { environmentId, label, status: "connecting" });
    for (;;) {
      const exit = yield* Effect.exit(
        follow(source, (id) => {
          environmentId = id;
          failures = 0;
        }),
      );
      failures += 1;
      const detail = Exit.isFailure(exit) ? failureDetail(exit.cause) : "The connection closed.";
      yield* Effect.logDebug("menu bar connection ended", { source: source.key, detail });
      if (environmentId !== null) {
        yield* publish(
          source.key,
          failures >= FAILURES_BEFORE_UNAVAILABLE
            ? { environmentId, label, status: "unavailable", reason: detail }
            : { environmentId, label, status: "connecting" },
        );
      }
      yield* Effect.sleep(
        Duration.millis(Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (failures - 1))),
      );
    }
  });

  const fibers = yield* FiberMap.make<string>();
  let running = new Map<string, string>();
  const reconcile = Effect.gen(function* () {
    const raw = yield* catalogStore.get.pipe(
      Effect.tapError((error) => Effect.logWarning("menu bar could not read connections", error)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const remote = Option.isNone(raw)
      ? []
      : menuBarRemoteSources(
          yield* decodeCatalog(raw.value).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("menu bar could not decode connections", error),
            ),
            Effect.orElseSucceed(() => EMPTY_CONNECTION_CATALOG_DOCUMENT),
          ),
        );
    const { localEnvironmentEnabled } = yield* settings.get;
    const sources: ReadonlyArray<MenuBarSource> = localEnvironmentEnabled
      ? [{ _tag: "local", key: "local" }, ...remote]
      : remote;
    const next = new Map(sources.map((source) => [source.key, JSON.stringify(source)]));
    for (const key of running.keys()) {
      if (next.has(key)) continue;
      yield* FiberMap.remove(fibers, key);
      yield* publish(key, null);
    }
    for (const source of sources) {
      if (running.get(source.key) === next.get(source.key)) continue;
      if (source._tag === "unsupported") {
        yield* FiberMap.remove(fibers, source.key);
        yield* publish(source.key, {
          environmentId: source.environmentId,
          label: source.label,
          status: "unavailable",
          reason: source.reason,
        });
      } else {
        yield* FiberMap.run(fibers, source.key, supervise(source));
      }
    }
    running = next;
  });

  yield* reconcile;
  yield* catalogStore.changes.pipe(
    Stream.runForEach(() => reconcile),
    Effect.forkScoped,
  );
  return environments;
});
