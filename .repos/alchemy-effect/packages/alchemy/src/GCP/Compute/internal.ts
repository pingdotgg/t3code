import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  waitGlobalOperation,
  waitOrganizationOperation,
  waitRegionOperation,
} from "./operations.ts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { alchemyLabelKeys } from "../Labels.ts";

export const MAX_NAME_LENGTH = 63;

export const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? value;
};

export const normalizeRegion = (
  region: string | undefined,
  defaultRegion: string,
) => lastSegment(region ?? defaultRegion).toLowerCase();

export const rfc1035 = (name: string, fallback: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `${fallback[0] ?? "r"}${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : fallback;
};

export const toPhysicalName = (
  id: string,
  name: string | undefined,
  existing: string | undefined,
  fallback: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const sameUrlList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  sameJson(
    sorted((left ?? []).map(lastSegment)),
    sorted((right ?? []).map(lastSegment)),
  );

export interface RunOperationOptions {
  /** Treat `RESOURCE_ALREADY_EXISTS` as success (idempotent insert). */
  ignoreAlreadyExists?: boolean;
  /** Treat `RESOURCE_NOT_FOUND` as success (idempotent delete). */
  ignoreNotFound?: boolean;
}

export const ignoredCodes = (options: RunOperationOptions | undefined) => [
  ...(options?.ignoreAlreadyExists === true ? ["RESOURCE_ALREADY_EXISTS"] : []),
  ...(options?.ignoreNotFound === true ? ["RESOURCE_NOT_FOUND"] : []),
];

/**
 * Start a Compute operation and wait for it. The insert/delete call itself
 * is retried while another operation holds the resource (`Conflict`).
 */
const runOp = <E extends { readonly _tag: string }, R, E2, R2>(
  start: Effect.Effect<compute.Operation, E, R>,
  wait: (
    operation: compute.Operation,
  ) => Effect.Effect<compute.Operation, E2, R2>,
) =>
  start.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.flatMap(wait),
  );

export const runRegionOp = <E extends { readonly _tag: string }, R>(
  project: string,
  region: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: RunOperationOptions,
) =>
  runOp(start, (operation) =>
    waitRegionOperation(project, region, operation, {
      ignore: ignoredCodes(options),
    }),
  );

export const runGlobalOp = <E extends { readonly _tag: string }, R>(
  project: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: RunOperationOptions,
) =>
  runOp(start, (operation) =>
    waitGlobalOperation(project, operation, { ignore: ignoredCodes(options) }),
  );

export const runOrgOp = <E extends { readonly _tag: string }, R>(
  parentId: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: RunOperationOptions,
) =>
  runOp(start, (operation) =>
    waitOrganizationOperation(operation, parentId, {
      ignore: ignoredCodes(options),
    }),
  );
