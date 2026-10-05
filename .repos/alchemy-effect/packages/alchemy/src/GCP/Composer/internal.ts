import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

export const MAX_NAME_LENGTH = 63;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "workload";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

export type ParsedWorkloadName = {
  project: string;
  location: string;
  environmentId: string;
  configMapId: string | undefined;
  secretId: string | undefined;
};

export const parseWorkloadName = (name: string): ParsedWorkloadName => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const get = (key: string) => {
    const index = parts.lastIndexOf(key);
    return index >= 0 ? parts[index + 1] : undefined;
  };
  return {
    project: get("projects") ?? "",
    // Environment names are always fully qualified; no regional default.
    location: get("locations") ?? "",
    environmentId: get("environments") ?? lastSegment(name),
    configMapId: get("userWorkloadsConfigMaps"),
    secretId: get("userWorkloadsSecrets"),
  };
};

export const environmentParent = (environmentName: string) => {
  const parsed = parseWorkloadName(environmentName);
  return `projects/${parsed.project}/locations/${parsed.location}/environments/${parsed.environmentId}`;
};

export const mapOf = (
  map: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const dataKey = (
  map: Record<string, string | undefined> | null | undefined,
) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(mapOf(map)).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
