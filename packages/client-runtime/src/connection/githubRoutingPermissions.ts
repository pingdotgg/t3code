import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";

export const GitHubRoutingPermission = Schema.Literals(["off", "read", "read-write"]);
export type GitHubRoutingPermission = typeof GitHubRoutingPermission.Type;
export const StoredGitHubRoutingPermission = Schema.Struct({
  environmentId: EnvironmentId,
  connectionKey: Schema.String,
  permission: GitHubRoutingPermission,
});
export type StoredGitHubRoutingPermission = typeof StoredGitHubRoutingPermission.Type;

/**
 * Trust belongs to the saved endpoints, never to an environment id advertised
 * by a server alone. With several routes the key covers all of them, sorted so
 * reordering keeps trust but adding or changing an address revokes it.
 */
export function gitHubRoutingConnectionKey(entry: ConnectionCatalogEntry): string | null {
  // Learned routes come and go with the server's addresses and reuse a saved
  // route's credential, so they leave trust where the user put it.
  const routes = [
    { target: entry.target, profile: entry.profile },
    ...(entry.alternateRoutes ?? []),
  ].filter((route) => {
    const profile = Option.getOrNull(route.profile);
    return !(profile?._tag === "BearerConnectionProfile" && profile.learned === true);
  });
  if (routes.length === 1) return routeConnectionKey(routes[0]!.target, routes[0]!.profile);
  const keys = routes.map((route) => routeConnectionKey(route.target, route.profile));
  return keys.every((key) => key !== null) ? JSON.stringify([...keys].sort()) : null;
}

function routeConnectionKey(
  target: ConnectionCatalogEntry["target"],
  routeProfile: ConnectionCatalogEntry["profile"],
): string | null {
  const entry = { profile: routeProfile };
  if (target._tag === "RelayConnectionTarget")
    return JSON.stringify([target._tag, target.environmentId]);
  const profile = Option.getOrNull(entry.profile);
  if (target._tag === "SshConnectionTarget") {
    if (profile?._tag !== "SshConnectionProfile") return null;
    const { alias, hostname, username, port } = profile.target;
    return JSON.stringify([target._tag, target.environmentId, alias, hostname, username, port]);
  }
  const baseUrls =
    target._tag === "PrimaryConnectionTarget"
      ? [target.httpBaseUrl, target.wsBaseUrl]
      : profile?._tag === "BearerConnectionProfile"
        ? [profile.httpBaseUrl, profile.wsBaseUrl]
        : null;
  if (baseUrls === null) return null;
  try {
    const urls = baseUrls.map((baseUrl) => new URL(baseUrl));
    if (
      !["http:", "https:"].includes(urls[0]!.protocol) ||
      !["ws:", "wss:"].includes(urls[1]!.protocol) ||
      urls.some((url) => url.username || url.password)
    )
      return null;
    return JSON.stringify([
      target._tag,
      target.environmentId,
      ...urls.map((url) => url.href.replace(/\/+$/, "")),
    ]);
  } catch {
    return null;
  }
}

export function gitHubRoutingPermissionFor(
  entry: ConnectionCatalogEntry,
  permissions: ReadonlyArray<StoredGitHubRoutingPermission>,
): GitHubRoutingPermission {
  const key = gitHubRoutingConnectionKey(entry);
  return key === null
    ? "off"
    : (permissions.find((permission) => permission.connectionKey === key)?.permission ?? "off");
}

export class GitHubRoutingPermissions extends Context.Reference<{
  readonly get: (entry: ConnectionCatalogEntry) => Effect.Effect<GitHubRoutingPermission>;
  readonly changes: Stream.Stream<ReadonlyArray<StoredGitHubRoutingPermission>>;
  readonly set: (
    entry: ConnectionCatalogEntry,
    permission: GitHubRoutingPermission,
  ) => Effect.Effect<void, ConnectionAttemptError>;
  readonly forget: (environmentId: EnvironmentId) => Effect.Effect<void, ConnectionAttemptError>;
}>("@t3tools/client-runtime/connection/GitHubRoutingPermissions", {
  defaultValue: () => ({
    get: () => Effect.succeed("off"),
    changes: Stream.succeed([]),
    set: () =>
      Effect.fail(
        new ConnectionBlockedError({
          reason: "unsupported",
          detail: "GitHub routing preferences are unavailable on this client.",
        }),
      ),
    forget: () => Effect.void,
  }),
}) {}

export const makeGitHubRoutingPermissions = Effect.fn("makeGitHubRoutingPermissions")(
  function* (storage: {
    readonly read: Effect.Effect<
      ReadonlyArray<StoredGitHubRoutingPermission>,
      ConnectionAttemptError
    >;
    readonly write: (
      permissions: ReadonlyArray<StoredGitHubRoutingPermission>,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }) {
    const state = yield* SubscriptionRef.make(yield* storage.read);
    const lock = yield* Semaphore.make(1);
    const update = (
      transform: (
        current: ReadonlyArray<StoredGitHubRoutingPermission>,
      ) => ReadonlyArray<StoredGitHubRoutingPermission>,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          const next = transform(current);
          if (next === current) return;
          yield* storage.write(next);
          yield* SubscriptionRef.set(state, next);
        }),
      );
    return GitHubRoutingPermissions.of({
      get: (entry) =>
        SubscriptionRef.get(state).pipe(
          Effect.map((permissions) => gitHubRoutingPermissionFor(entry, permissions)),
        ),
      changes: SubscriptionRef.changes(state),
      set: (entry, permission) => {
        const connectionKey = gitHubRoutingConnectionKey(entry);
        if (connectionKey === null)
          return Effect.fail(
            new ConnectionBlockedError({
              reason: "configuration",
              detail: "This environment does not have a saved connection endpoint.",
            }),
          );
        return update((current) => [
          ...current.filter((value) => value.environmentId !== entry.target.environmentId),
          ...(permission === "off"
            ? []
            : [{ environmentId: entry.target.environmentId, connectionKey, permission }]),
        ]);
      },
      forget: (environmentId) =>
        update((current) =>
          current.some((permission) => permission.environmentId === environmentId)
            ? current.filter((permission) => permission.environmentId !== environmentId)
            : current,
        ),
    });
  },
);
