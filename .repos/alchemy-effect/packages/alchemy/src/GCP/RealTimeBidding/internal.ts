import * as rtb from "@distilled.cloud/gcp/realtimebidding_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 255;
export const PROBE_PARENT = "bidders/1";
export const PROBE_NAME = `${PROBE_PARENT}/pretargetingConfigs/0`;

export type TargetingMode =
  | rtb.StringTargetingDimensionTargetingModeEnum
  | (string & {});

export type StringTargetingDimensionValue = {
  targetingMode?: TargetingMode;
  values?: string[];
};

export type NumericTargetingDimensionValue = {
  includedIds?: string[];
  excludedIds?: string[];
};

export type CreativeDimensionsValue = {
  width?: string;
  height?: string;
};

export type AppTargetingValue = {
  mobileAppTargeting?: StringTargetingDimensionValue;
  mobileAppCategoryTargeting?: NumericTargetingDimensionValue;
};

export type PretargetingState = rtb.PretargetingConfigStateEnum | (string & {});

export type PretargetingSpec = {
  allowedUserTargetingModes?: string[];
  excludedContentLabelIds?: string[];
  includedLanguages?: string[];
  webTargeting?: StringTargetingDimensionValue;
  includedPlatforms?: string[];
  includedFormats?: string[];
  maximumQps?: string;
  geoTargeting?: NumericTargetingDimensionValue;
  includedEnvironments?: string[];
  userListTargeting?: NumericTargetingDimensionValue;
  publisherTargeting?: StringTargetingDimensionValue;
  includedUserIdTypes?: string[];
  minimumViewabilityDecile?: number;
  verticalTargeting?: NumericTargetingDimensionValue;
  includedCreativeDimensions?: CreativeDimensionsValue[];
  interstitialTargeting?: string;
  appTargeting?: AppTargetingValue;
  includedMobileOperatingSystemIds?: string[];
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeResourceName = (value: string) =>
  value.replace(/\/+$/, "").trim();

export const expandParent = (value: string) => {
  const trimmed = normalizeResourceName(value);
  if (trimmed.length === 0) return trimmed;
  return trimmed.startsWith("bidders/") ? trimmed : `bidders/${trimmed}`;
};

export const parentOfName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const plural = parts.lastIndexOf("pretargetingConfigs");
  const singular = parts.lastIndexOf("pretargetingConfig");
  const index = Math.max(plural, singular);
  if (index > 0) return parts.slice(0, index).join("/");
  return "";
};

export const resourceName = (parent: string, configId: string) =>
  `${expandParent(parent)}/pretargetingConfigs/${configId}`;

export const configIdOf = (name: string) => lastSegment(name);

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
    if (items.length === 0) return undefined;
    const allScalar = items.every(
      (item) => item === undefined || typeof item !== "object",
    );
    return allScalar
      ? [...items].sort((left, right) =>
          String(left).localeCompare(String(right)),
        )
      : items;
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

export const jsonEqual = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const replaceOnIdentity = (input: {
  previousParent?: string;
  nextParent: string;
  previousId?: string;
  nextId?: string;
}) => {
  if (
    input.previousParent !== undefined &&
    input.previousParent.length > 0 &&
    input.nextParent.length > 0 &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: true };
  }
  return undefined;
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const fitMarker = (
  labels: Record<string, string>,
  maxLength: number,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (id.length >= stack.length && id.length >= stage.length) {
      id = id.slice(0, -1);
    } else if (stack.length >= stage.length) {
      stack = stack.slice(0, -1);
    } else {
      stage = stage.slice(0, -1);
    }
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeDisplayName = (
  labels: Record<string, string>,
  displayName: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = displayName?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseDisplayName = (
  displayName: string | undefined,
): {
  labels: Record<string, string>;
  displayName: string | undefined;
} => {
  if (!displayName?.startsWith("[alchemy ")) {
    return { labels: {}, displayName };
  }
  const end = displayName.indexOf("]");
  if (end < 0) return { labels: {}, displayName };
  const labels: Record<string, string> = {};
  for (const part of displayName.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = displayName.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, displayName: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (displayName: string | undefined) =>
  Object.keys(parseDisplayName(displayName).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, displayName: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseDisplayName(displayName);
    if (!hasOwnershipMarker(displayName)) return false;
    if (yield* hasAlchemyLabels(id, labels)) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return parseDisplayName(requested).displayName ?? requested;
    }
    if (existing !== undefined && existing.length > 0) {
      return parseDisplayName(existing).displayName ?? existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `c${generated}`.slice(0, 40);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const collectPages = <A, Page, E, R>(
  pages: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" }> =>
  error._tag === "NotFound";

export const ignoreList =
  <A>(fallback: A) =>
  <A1, E extends { readonly _tag: string }, R>(
    self: Effect.Effect<A1, E, R>,
  ): Effect.Effect<A1 | A, E, R> =>
    self.pipe(Effect.catchIf(isMissing, () => Effect.succeed(fallback)));

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) => effect.pipe(Effect.catchIf(isMissing, () => Effect.void));

export const getConfig = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : rtb
        .getBiddersPretargetingConfigs({ name })
        .pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));

export const listConfigs = (parent: string) =>
  parent.length === 0
    ? emptyList<rtb.PretargetingConfig>()
    : collectPages(
        rtb.listBiddersPretargetingConfigs.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.pretargetingConfigs,
      ).pipe(ignoreList([] as rtb.PretargetingConfig[]));

export const listBidderAccounts = () =>
  collectPages(
    rtb.listBidders.pages({ pageSize: 100 }),
    (page) => page.bidders,
  ).pipe(ignoreList([] as rtb.Bidder[]));

export const listParentsForNuke = () =>
  Effect.gen(function* () {
    const bidders = yield* listBidderAccounts();
    const listed = bidders
      .map((bidder) => bidder.name)
      .filter((name): name is string => !!name)
      .map(expandParent);
    return [...new Set(listed)];
  });

export const listOwnedConfigs = () =>
  Effect.gen(function* () {
    const parents = yield* listParentsForNuke();
    const pages = yield* Effect.forEach(parents, listConfigs, {
      concurrency: 4,
    });
    return pages.flat().filter((row) => hasOwnershipMarker(row.displayName));
  });

export const findOwnedConfig = (
  id: string,
  parent?: string,
  name?: string,
  displayName?: string,
) =>
  Effect.gen(function* () {
    const rows =
      parent && parent.length > 0
        ? yield* listConfigs(parent)
        : yield* listOwnedConfigs();
    if (name) {
      const exact = rows.find((row) => row.name === name);
      if (exact) return exact;
    }
    if (displayName) {
      const named = rows.find((row) => sameText(row.displayName, displayName));
      if (named) return named;
    }
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.displayName)) {
        return row;
      }
    }
    return undefined;
  });

const keep = <T>(news: T | undefined, current: T | undefined) =>
  news !== undefined ? news : current;

export const specOf = (input: PretargetingSpec): PretargetingSpec => ({
  allowedUserTargetingModes: input.allowedUserTargetingModes,
  excludedContentLabelIds: input.excludedContentLabelIds,
  includedLanguages: input.includedLanguages,
  webTargeting: input.webTargeting,
  includedPlatforms: input.includedPlatforms,
  includedFormats: input.includedFormats,
  maximumQps: input.maximumQps,
  geoTargeting: input.geoTargeting,
  includedEnvironments: input.includedEnvironments,
  userListTargeting: input.userListTargeting,
  publisherTargeting: input.publisherTargeting,
  includedUserIdTypes: input.includedUserIdTypes,
  minimumViewabilityDecile: input.minimumViewabilityDecile,
  verticalTargeting: input.verticalTargeting,
  includedCreativeDimensions: input.includedCreativeDimensions,
  interstitialTargeting: input.interstitialTargeting,
  appTargeting: input.appTargeting,
  includedMobileOperatingSystemIds: input.includedMobileOperatingSystemIds,
});

export const specFromRow = (row: rtb.PretargetingConfig): PretargetingSpec =>
  specOf({
    allowedUserTargetingModes: row.allowedUserTargetingModes,
    excludedContentLabelIds: row.excludedContentLabelIds,
    includedLanguages: row.includedLanguages,
    webTargeting: row.webTargeting,
    includedPlatforms: row.includedPlatforms,
    includedFormats: row.includedFormats,
    maximumQps: row.maximumQps,
    geoTargeting: row.geoTargeting,
    includedEnvironments: row.includedEnvironments,
    userListTargeting: row.userListTargeting,
    publisherTargeting: row.publisherTargeting,
    includedUserIdTypes: row.includedUserIdTypes,
    minimumViewabilityDecile: row.minimumViewabilityDecile,
    verticalTargeting: row.verticalTargeting,
    includedCreativeDimensions: row.includedCreativeDimensions,
    interstitialTargeting: row.interstitialTargeting,
    appTargeting: row.appTargeting,
    includedMobileOperatingSystemIds: row.includedMobileOperatingSystemIds,
  });

export const mergeSpec = (
  news: PretargetingSpec,
  current: PretargetingSpec | undefined,
): PretargetingSpec => ({
  allowedUserTargetingModes: keep(
    news.allowedUserTargetingModes,
    current?.allowedUserTargetingModes,
  ),
  excludedContentLabelIds: keep(
    news.excludedContentLabelIds,
    current?.excludedContentLabelIds,
  ),
  includedLanguages: keep(news.includedLanguages, current?.includedLanguages),
  webTargeting: keep(news.webTargeting, current?.webTargeting),
  includedPlatforms: keep(news.includedPlatforms, current?.includedPlatforms),
  includedFormats: keep(news.includedFormats, current?.includedFormats),
  maximumQps: keep(news.maximumQps, current?.maximumQps),
  geoTargeting: keep(news.geoTargeting, current?.geoTargeting),
  includedEnvironments: keep(
    news.includedEnvironments,
    current?.includedEnvironments,
  ),
  userListTargeting: keep(news.userListTargeting, current?.userListTargeting),
  publisherTargeting: keep(
    news.publisherTargeting,
    current?.publisherTargeting,
  ),
  includedUserIdTypes: keep(
    news.includedUserIdTypes,
    current?.includedUserIdTypes,
  ),
  minimumViewabilityDecile: keep(
    news.minimumViewabilityDecile,
    current?.minimumViewabilityDecile,
  ),
  verticalTargeting: keep(news.verticalTargeting, current?.verticalTargeting),
  includedCreativeDimensions: keep(
    news.includedCreativeDimensions,
    current?.includedCreativeDimensions,
  ),
  interstitialTargeting: keep(
    news.interstitialTargeting,
    current?.interstitialTargeting,
  ),
  appTargeting: keep(news.appTargeting, current?.appTargeting),
  includedMobileOperatingSystemIds: keep(
    news.includedMobileOperatingSystemIds,
    current?.includedMobileOperatingSystemIds,
  ),
});

export const toConfigBody = (
  displayName: string,
  spec: PretargetingSpec,
): rtb.PretargetingConfig => ({
  displayName,
  allowedUserTargetingModes: spec.allowedUserTargetingModes,
  excludedContentLabelIds: spec.excludedContentLabelIds,
  includedLanguages: spec.includedLanguages,
  webTargeting: spec.webTargeting,
  includedPlatforms: spec.includedPlatforms,
  includedFormats: spec.includedFormats,
  maximumQps: spec.maximumQps,
  geoTargeting: spec.geoTargeting,
  includedEnvironments: spec.includedEnvironments,
  userListTargeting: spec.userListTargeting,
  publisherTargeting: spec.publisherTargeting,
  includedUserIdTypes: spec.includedUserIdTypes,
  minimumViewabilityDecile: spec.minimumViewabilityDecile,
  verticalTargeting: spec.verticalTargeting,
  includedCreativeDimensions: spec.includedCreativeDimensions,
  interstitialTargeting: spec.interstitialTargeting,
  appTargeting: spec.appTargeting,
  includedMobileOperatingSystemIds: spec.includedMobileOperatingSystemIds,
});

const PATCH_FIELDS = [
  ["allowedUserTargetingModes", "allowedUserTargetingModes"],
  ["excludedContentLabelIds", "excludedContentLabelIds"],
  ["includedLanguages", "includedLanguages"],
  ["webTargeting", "webTargeting"],
  ["includedPlatforms", "includedPlatforms"],
  ["includedFormats", "includedFormats"],
  ["maximumQps", "maximumQps"],
  ["geoTargeting", "geoTargeting"],
  ["includedEnvironments", "includedEnvironments"],
  ["userListTargeting", "userListTargeting"],
  ["publisherTargeting", "publisherTargeting"],
  ["includedUserIdTypes", "includedUserIdTypes"],
  ["minimumViewabilityDecile", "minimumViewabilityDecile"],
  ["verticalTargeting", "verticalTargeting"],
  ["includedCreativeDimensions", "includedCreativeDimensions"],
  ["interstitialTargeting", "interstitialTargeting"],
  ["appTargeting", "appTargeting"],
  ["includedMobileOperatingSystemIds", "includedMobileOperatingSystemIds"],
] as const satisfies ReadonlyArray<
  readonly [keyof PretargetingSpec, keyof PretargetingSpec]
>;

export const updateMaskOf = (
  current: rtb.PretargetingConfig,
  desired: PretargetingSpec,
  displayName: string,
) => {
  const fields: string[] = [];
  if (!sameText(current.displayName, displayName)) {
    fields.push("displayName");
  }
  const observed = specFromRow(current);
  for (const [key, mask] of PATCH_FIELDS) {
    if (!jsonEqual(observed[key], desired[key])) {
      fields.push(mask);
    }
  }
  return fields.join(",");
};
