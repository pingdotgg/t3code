import * as websecurityscanner from "@distilled.cloud/gcp/websecurityscanner_v1";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectParent = (project: string) => `projects/${project}`;

export const scanConfigNameOf = (project: string, scanConfigId: string) =>
  `projects/${project}/scanConfigs/${scanConfigId}`;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const stringList = (
  values: readonly (string | undefined)[] | null | undefined,
): string[] =>
  (values ?? []).filter((value): value is string => typeof value === "string");

export const unspecified = (value: string | undefined) =>
  value === undefined || value.length === 0 || value.endsWith("_UNSPECIFIED")
    ? ""
    : value;

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toUserDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 80,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
  });

export const getScanConfig = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : websecurityscanner
        .getProjectsScanConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
