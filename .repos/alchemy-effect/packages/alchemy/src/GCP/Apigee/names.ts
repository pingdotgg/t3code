import { createPhysicalName } from "../../PhysicalName.ts";
import * as Effect from "effect/Effect";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const organizationOf = (
  explicit: string | undefined,
  existing: string | undefined,
  project: string,
) => explicit ?? existing ?? project;

export const orgParent = (organization: string) =>
  `organizations/${organization}`;

export const organizationFromName = (name: string | undefined) => {
  if (name === undefined) return undefined;
  const match = name.match(/^organizations\/([^/]+)/);
  return match?.[1];
};

export const toResourceId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength: number,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    let generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    if (!/^[a-z]/.test(generated)) {
      generated = `a${generated}`.slice(0, maxLength);
    }
    generated = generated.replace(/-+$/g, "");
    if (generated.length < 2) {
      generated = `${generated}x`.slice(0, maxLength);
    }
    return generated;
  });

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());
