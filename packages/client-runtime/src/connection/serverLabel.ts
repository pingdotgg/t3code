import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import { connectionRoutes, entryWithRoutes } from "./routes.ts";

/** Conn: the same target under another name. `setByUser` marks a name the person chose. */
export function withTargetLabel(
  target: ConnectionTarget,
  label: string,
  setByUser: boolean = target.labelSetByUser === true,
): ConnectionTarget {
  const named = {
    environmentId: target.environmentId,
    label,
    ...(setByUser ? { labelSetByUser: true as const } : {}),
  };
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return new PrimaryConnectionTarget({
        ...named,
        httpBaseUrl: target.httpBaseUrl,
        wsBaseUrl: target.wsBaseUrl,
      });
    case "BearerConnectionTarget":
      return new BearerConnectionTarget({ ...named, connectionId: target.connectionId });
    case "RelayConnectionTarget":
      return new RelayConnectionTarget(named);
    case "SshConnectionTarget":
      return new SshConnectionTarget({ ...named, connectionId: target.connectionId });
  }
}

/** Conn: the name the person gave this environment, or null when it carries the server's name. */
function userSetLabel(entry: ConnectionCatalogEntry): string | null {
  return (
    connectionRoutes(entry).find((route) => route.target.labelSetByUser === true)?.target.label ??
    null
  );
}

/**
 * Conn: a saved environment takes the name its server presents, so a renamed machine (an Orbit
 * container named `<instance>.<project>`) stops showing the name it had when it was paired.
 * Returns null when nothing changes: another environment answered, the server gave no name, the
 * person named the environment, or every route already carries the name.
 */
export function entryWithServerLabel(
  entry: ConnectionCatalogEntry,
  environmentId: EnvironmentId,
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionCatalogEntry | null {
  if (entry.target.environmentId !== environmentId) return null;
  if (descriptor.environmentId !== environmentId) return null;
  const label = typeof descriptor.label === "string" ? descriptor.label.trim() : "";
  if (label === "") return null;
  if (userSetLabel(entry) !== null) return null;
  const routes = connectionRoutes(entry);
  if (routes.every((route) => route.target.label === label)) return null;
  return entryWithRoutes(
    entry,
    routes.map((route): ConnectionRoute =>
      route.target.label === label
        ? route
        : { target: withTargetLabel(route.target, label), profile: route.profile },
    ),
  );
}

/**
 * Conn: one name the person chose holds for the whole environment. A route saved with such a name
 * (the phone's Label field) gives it to every route; a route paired again, which carries the
 * server's name, takes the name the person chose before.
 */
export function routesWithUserLabel(
  previous: ConnectionCatalogEntry,
  registered: ConnectionTarget,
  routes: ReadonlyArray<ConnectionRoute>,
): ReadonlyArray<ConnectionRoute> {
  const chosen = registered.labelSetByUser === true ? registered.label : userSetLabel(previous);
  if (chosen === null) return routes;
  return routes.map((route) =>
    route.target.labelSetByUser === true && route.target.label === chosen
      ? route
      : { target: withTargetLabel(route.target, chosen, true), profile: route.profile },
  );
}
