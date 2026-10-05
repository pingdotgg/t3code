import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { hasAlchemyLabels } from "../Labels.ts";

export const MAX_DESCRIPTION_LENGTH = 256;
export const MAX_DISPLAY_NAME_LENGTH = 63;
export const MAX_PATH_LENGTH = 200;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectParent = (project: string) => `projects/${project}`;

export const keyNameOf = (project: string, keyId: string) =>
  `projects/${project}/keys/${keyId}`;

export const firewallNameOf = (project: string, firewallpolicyId: string) =>
  `projects/${project}/firewallpolicies/${firewallpolicyId}`;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const stringList = (
  values: readonly (string | undefined)[] | null | undefined,
): string[] =>
  (values ?? []).filter((value): value is string => typeof value === "string");

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
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

export const toGeneratedPath = (id: string, requested: string | undefined) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    const path = `/alc/${generated}`.slice(0, MAX_PATH_LENGTH);
    return path.length > 0 ? path : "/alc";
  });

export const getKey = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : recaptchaenterprise
        .getProjectsKeys({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getFirewallPolicy = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : recaptchaenterprise
        .getProjectsFirewallpolicies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listKeys = (project: string) =>
  recaptchaenterprise.listProjectsKeys
    .pages({
      parent: projectParent(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.keys ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

export const listFirewallPolicies = (project: string) =>
  recaptchaenterprise.listProjectsFirewallpolicies
    .pages({
      parent: projectParent(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.firewallPolicies ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

export const findOwnedKey = (project: string, id: string, name?: string) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getKey(name);
      if (existing !== undefined) return existing;
    }
    const keys = yield* listKeys(project);
    for (const key of keys) {
      if (yield* hasAlchemyLabels(id, tagRecord(key.labels))) {
        return key;
      }
    }
    return undefined;
  });
