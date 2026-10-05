import * as agentidentity from "@distilled.cloud/gcp/agentidentity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { ALCHEMY_LABEL_PREFIX, stripInternalLabels } from "../Labels.ts";

export const MAX_NAME_LENGTH = 63;
export const MAX_DESCRIPTION_LENGTH = 256;
export const COLLECTION = "authProviders";

export class AuthProviderNotResolved extends Data.TaggedError(
  "GCP.AgentIdentity.AuthProviderNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "auth"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "a"}${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${lastSegment(location).toLowerCase()}`;

export const resourceName = (
  project: string,
  location: string,
  authProviderId: string,
) => `${parentOf(project, location)}/${COLLECTION}/${authProviderId}`;

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
      "auth",
    );
  });

export const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(COLLECTION);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    authProviderId:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
  };
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  fingerprint([...(left ?? [])].slice().sort()) ===
  fingerprint([...(right ?? [])].slice().sort());

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const clipDescription = (description: string | undefined) => {
  if (description === undefined) return undefined;
  return description.slice(0, MAX_DESCRIPTION_LENGTH);
};

export type ThreeLeggedOAuthParams = {
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  defaultContinueUri?: string;
  enablePkce?: boolean;
};

export type TwoLeggedOAuthParams = {
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
};

export type ApiKeyParams = {
  apiKey?: string;
};

export type AuthProviderTypeParams = {
  threeLeggedOauth?: ThreeLeggedOAuthParams;
  twoLeggedOauth?: TwoLeggedOAuthParams;
  apiKey?: ApiKeyParams;
  geAuthProvider?: Record<string, never> | {};
};

const publicThreeLegged = (value: ThreeLeggedOAuthParams | undefined) =>
  value === undefined
    ? undefined
    : {
        clientId: value.clientId,
        authorizationUrl: value.authorizationUrl,
        tokenUrl: value.tokenUrl,
        defaultContinueUri: value.defaultContinueUri,
        enablePkce: value.enablePkce,
      };

const publicTwoLegged = (value: TwoLeggedOAuthParams | undefined) =>
  value === undefined
    ? undefined
    : {
        clientId: value.clientId,
        tokenUrl: value.tokenUrl,
      };

export const typeKind = (params: AuthProviderTypeParams | undefined) => {
  if (params?.threeLeggedOauth !== undefined) return "threeLeggedOauth";
  if (params?.twoLeggedOauth !== undefined) return "twoLeggedOauth";
  if (params?.apiKey !== undefined) return "apiKey";
  if (params?.geAuthProvider !== undefined) return "geAuthProvider";
  return undefined;
};

export const publicTypeParams = (
  params: AuthProviderTypeParams | undefined,
) => {
  if (params === undefined || typeKind(params) === undefined) return undefined;
  return {
    kind: typeKind(params),
    threeLeggedOauth: publicThreeLegged(params.threeLeggedOauth),
    twoLeggedOauth: publicTwoLegged(params.twoLeggedOauth),
  };
};

export const hasSecretUpdate = (
  news: AuthProviderTypeParams | undefined,
  olds: AuthProviderTypeParams | undefined,
) => {
  if (news === undefined || olds === undefined) return false;
  const apiKeyChanged =
    news.apiKey?.apiKey !== undefined &&
    news.apiKey.apiKey !== olds.apiKey?.apiKey;
  const threeSecretChanged =
    news.threeLeggedOauth?.clientSecret !== undefined &&
    news.threeLeggedOauth.clientSecret !== olds.threeLeggedOauth?.clientSecret;
  const twoSecretChanged =
    news.twoLeggedOauth?.clientSecret !== undefined &&
    news.twoLeggedOauth.clientSecret !== olds.twoLeggedOauth?.clientSecret;
  return apiKeyChanged || threeSecretChanged || twoSecretChanged;
};

export const toTypeParams = (
  params:
    | agentidentity.AuthProviderTypeParams
    | AuthProviderTypeParams
    | undefined,
): AuthProviderTypeParams | undefined => {
  if (params === undefined) return undefined;
  const three = params.threeLeggedOauth;
  const two = params.twoLeggedOauth;
  const apiKey = params.apiKey;
  const ge = params.geAuthProvider;
  if (
    three === undefined &&
    two === undefined &&
    apiKey === undefined &&
    ge === undefined
  ) {
    return undefined;
  }
  return {
    threeLeggedOauth:
      three === undefined
        ? undefined
        : {
            clientId: three.clientId,
            authorizationUrl: three.authorizationUrl,
            tokenUrl: three.tokenUrl,
            defaultContinueUri: three.defaultContinueUri,
            enablePkce: three.enablePkce,
          },
    twoLeggedOauth:
      two === undefined
        ? undefined
        : {
            clientId: two.clientId,
            tokenUrl: two.tokenUrl,
          },
    apiKey: apiKey === undefined ? undefined : {},
    geAuthProvider: ge === undefined ? undefined : {},
  };
};

export const typeParamsBody = (
  params: AuthProviderTypeParams | undefined,
): agentidentity.AuthProviderTypeParams | undefined => {
  if (params === undefined) return undefined;
  return {
    threeLeggedOauth: params.threeLeggedOauth,
    twoLeggedOauth: params.twoLeggedOauth,
    apiKey: params.apiKey,
    geAuthProvider: params.geAuthProvider === undefined ? undefined : {},
  };
};

export const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : agentidentity
        .getProjectsLocationsAuthProviders({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPages = (parent: string) =>
  agentidentity.listProjectsLocationsAuthProviders
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.authProviders ?? [])),
      Stream.filter(
        (item) => item.deleted !== true && hasAlchemyLabelMap(item.labels),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as agentidentity.AuthProvider[]),
      ),
    );

const listLocationIds = (project: string, region: string) =>
  agentidentity.listProjectsLocations
    .pages({
      name: `projects/${project}`,
      pageSize: 200,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.locations ?? [])),
      Stream.map(
        (location) => location.locationId ?? lastSegment(location.name ?? ""),
      ),
      Stream.filter((id) => id.length > 0),
      Stream.runCollect,
      Effect.map((chunk) => {
        const ids = new Set(Array.from(chunk));
        ids.add(region);
        return [...ids];
      }),
      Effect.catchTag("NotFound", () => Effect.succeed([region])),
    );

export const listOwned = (project: string, region: string) =>
  Effect.gen(function* () {
    const wildcard = yield* listPages(`projects/${project}/locations/-`);
    if (wildcard.length > 0) return wildcard;
    const locations = yield* listLocationIds(project, region);
    const pages = yield* Effect.forEach(
      locations,
      (location) => listPages(parentOf(project, location)),
      { concurrency: "unbounded" },
    );
    const byName = new Map<string, agentidentity.AuthProvider>();
    for (const item of pages.flat()) {
      if (item.name) byName.set(item.name, item);
    }
    return [...byName.values()];
  });
