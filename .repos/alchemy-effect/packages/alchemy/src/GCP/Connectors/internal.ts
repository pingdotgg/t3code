import * as connectors from "@distilled.cloud/gcp/connectors_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export type EntityFields = Record<string, unknown>;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

const segmentAfter = (parts: readonly string[], key: string) => {
  const index = parts.lastIndexOf(key);
  return index >= 0 && parts[index + 1] ? parts[index + 1]! : "";
};

export const parseEntityName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return {
    project: segmentAfter(parts, "projects"),
    location: segmentAfter(parts, "locations"),
    connection: segmentAfter(parts, "connections"),
    entityType: segmentAfter(parts, "entityTypes"),
    entityId: segmentAfter(parts, "entities") || lastSegment(name),
    parent: parentOf(name),
  };
};

export const entityNameOf = (parent: string, entityId: string) =>
  `${parent.replace(/\/+$/, "")}/entities/${entityId}`;

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
};

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "TooManyRequests" ||
        error._tag === "InternalServerError" ||
        error._tag === "BadGateway" ||
        error._tag === "ServiceUnavailable" ||
        error._tag === "GatewayTimeout",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export const getEntity = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : connectors
        .getProjectsLocationsConnectionsEntityTypesEntities({ name })
        .pipe(
          // A missing connection answers 501, so its entities are gone too.
          Effect.catchTag(["NotFound", "EntitiesNotImplemented"], () =>
            Effect.succeed(undefined),
          ),
        );
