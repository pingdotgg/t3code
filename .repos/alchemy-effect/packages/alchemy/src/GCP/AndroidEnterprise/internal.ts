import * as androidenterprise from "@distilled.cloud/gcp/androidenterprise_v1";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_DISPLAY_MODE = "standalone";
export const MAX_NAME_LENGTH = 256;
export const MAX_TITLE_LENGTH = 100;

/** Whitespace/comma-separated list setting from the ConfigProvider (env by default). */
const listSetting = (keys: readonly string[]) =>
  Effect.gen(function* () {
    const values: string[] = [];
    for (const key of keys) {
      const raw = Option.getOrUndefined(
        yield* Config.option(Config.String(key)),
      )?.trim();
      if (!raw) continue;
      for (const part of raw.split(/[,\s]+/)) {
        if (part.length > 0) values.push(part);
      }
    }
    return values;
  });

/** Enterprises swept by `list` (nuke): `GCP_ANDROIDENTERPRISE_ENTERPRISE_IDS`. */
const configuredEnterpriseIds = () =>
  listSetting([
    "GCP_ANDROIDENTERPRISE_ENTERPRISE_ID",
    "GCP_ANDROIDENTERPRISE_ENTERPRISE_IDS",
    "GCP_ANDROID_ENTERPRISE_ID",
  ]);

/** Domain whose enterprises `list` sweeps: `GCP_ANDROIDENTERPRISE_DOMAIN`. */
const configuredDomain = () =>
  listSetting(["GCP_ANDROIDENTERPRISE_DOMAIN"]).pipe(
    Effect.map((values) => values[0] ?? ""),
  );

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].slice().sort(),
    [...(right ?? [])].slice().sort(),
  );

const emptyList = <A>() => Effect.succeed([] as A[]);

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" }> =>
  error._tag === "NotFound";

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));

export const ignoreList =
  <A>(fallback: A) =>
  <A1, E extends { readonly _tag: string }, R>(
    self: Effect.Effect<A1, E, R>,
  ): Effect.Effect<A1 | A, E, R> =>
    self.pipe(Effect.catchIf(isMissing, () => Effect.succeed(fallback)));

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
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

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: Math.min(40, maxLength),
      lowercase: true,
      delimiter: "-",
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `a${generated}`.slice(0, maxLength);
  });

/**
 * Localized names as given (or one default-locale entry). Names are shown
 * to device users, so no ownership marker is written into them.
 */
export const defaultNames = (
  names: readonly androidenterprise.LocalizedText[] | undefined,
  fallback: string,
): androidenterprise.LocalizedText[] =>
  names && names.length > 0
    ? names.map((entry) => ({
        ...entry,
        locale: entry.locale ?? DEFAULT_LOCALE,
      }))
    : [{ locale: DEFAULT_LOCALE, text: fallback }];

export const publicNames = (
  names: readonly androidenterprise.LocalizedText[] | undefined,
): androidenterprise.LocalizedText[] | undefined => {
  if (names === undefined) return undefined;
  return names.map((entry) => ({
    ...entry,
    text: parseOwnership(entry.text).text,
  }));
};

export const ownershipTextFromNames = (
  names: readonly androidenterprise.LocalizedText[] | undefined,
) => names?.[0]?.text;

/** Title as given; shown to device users, so it carries no marker. */
export const defaultTitle = (title: string | undefined, fallback: string) =>
  (title ?? fallback).slice(0, MAX_TITLE_LENGTH);

export const getPage = (enterpriseId: string, pageId: string) =>
  enterpriseId.length === 0 || pageId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        androidenterprise.getStorelayoutpages({ enterpriseId, pageId }),
      );

export const getCluster = (
  enterpriseId: string,
  pageId: string,
  clusterId: string,
) =>
  enterpriseId.length === 0 || pageId.length === 0 || clusterId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        androidenterprise.getStorelayoutclusters({
          enterpriseId,
          pageId,
          clusterId,
        }),
      );

export const getWebapp = (enterpriseId: string, webAppId: string) =>
  enterpriseId.length === 0 || webAppId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(androidenterprise.getWebapps({ enterpriseId, webAppId }));

export const listPagesAt = (enterpriseId: string) =>
  enterpriseId.length === 0
    ? emptyList<androidenterprise.StorePage>()
    : androidenterprise.listStorelayoutpages({ enterpriseId }).pipe(
        Effect.map((page) => page.page ?? []),
        ignoreList([] as androidenterprise.StorePage[]),
      );

export const listClustersAt = (enterpriseId: string, pageId: string) =>
  enterpriseId.length === 0 || pageId.length === 0
    ? emptyList<androidenterprise.StoreCluster>()
    : androidenterprise.listStorelayoutclusters({ enterpriseId, pageId }).pipe(
        Effect.map((page) => page.cluster ?? []),
        ignoreList([] as androidenterprise.StoreCluster[]),
      );

export const listWebappsAt = (enterpriseId: string) =>
  enterpriseId.length === 0
    ? emptyList<androidenterprise.WebApp>()
    : androidenterprise.listWebapps({ enterpriseId }).pipe(
        Effect.map((page) => page.webApp ?? []),
        ignoreList([] as androidenterprise.WebApp[]),
      );

const listEnterprisesAtDomain = (domain: string) =>
  domain.length === 0
    ? emptyList<androidenterprise.Enterprise>()
    : androidenterprise.listEnterprises({ domain }).pipe(
        Effect.map((page) => page.enterprise ?? []),
        ignoreList([] as androidenterprise.Enterprise[]),
      );

export const listEnterpriseIds = () =>
  Effect.gen(function* () {
    const fromEnv = yield* configuredEnterpriseIds();
    const domain = yield* configuredDomain();
    if (domain.length === 0) return fromEnv;
    const lookedUp = yield* listEnterprisesAtDomain(domain);
    const ids = lookedUp
      .map((enterprise) => enterprise.id)
      .filter((id): id is string => id !== undefined && id.length > 0);
    return [...new Set([...fromEnv, ...ids])];
  });

export const findOwnedPage = (id: string, enterpriseId: string) =>
  Effect.gen(function* () {
    const pages = yield* listPagesAt(enterpriseId);
    for (const page of pages) {
      if (yield* ownedByAlchemy(id, ownershipTextFromNames(page.name))) {
        return page;
      }
    }
    return undefined;
  });

export const findOwnedCluster = (
  id: string,
  enterpriseId: string,
  pageId?: string,
) =>
  Effect.gen(function* () {
    const pageIds = pageId
      ? [pageId]
      : (yield* listPagesAt(enterpriseId))
          .map((page) => page.id)
          .filter((value): value is string => value !== undefined);
    for (const currentPageId of pageIds) {
      const clusters = yield* listClustersAt(enterpriseId, currentPageId);
      for (const cluster of clusters) {
        if (yield* ownedByAlchemy(id, ownershipTextFromNames(cluster.name))) {
          return { cluster, pageId: currentPageId };
        }
      }
    }
    return undefined;
  });

export const findOwnedWebapp = (id: string, enterpriseId: string) =>
  Effect.gen(function* () {
    const webapps = yield* listWebappsAt(enterpriseId);
    for (const webapp of webapps) {
      if (yield* ownedByAlchemy(id, webapp.title)) {
        return webapp;
      }
    }
    return undefined;
  });

export const listOwnedPages = () =>
  Effect.gen(function* () {
    const enterpriseIds = yield* listEnterpriseIds();
    const pages = yield* Effect.forEach(
      enterpriseIds,
      (enterpriseId) =>
        listPagesAt(enterpriseId).pipe(
          Effect.map((items) =>
            items
              .filter((page) =>
                hasOwnershipMarker(ownershipTextFromNames(page.name)),
              )
              .map((page) => ({ page, enterpriseId })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedClusters = () =>
  Effect.gen(function* () {
    const enterpriseIds = yield* listEnterpriseIds();
    const pages = yield* Effect.forEach(
      enterpriseIds,
      (enterpriseId) =>
        Effect.gen(function* () {
          const storePages = yield* listPagesAt(enterpriseId);
          const clusters = yield* Effect.forEach(
            storePages,
            (page) =>
              page.id
                ? listClustersAt(enterpriseId, page.id).pipe(
                    Effect.map((items) =>
                      items
                        .filter((cluster) =>
                          hasOwnershipMarker(
                            ownershipTextFromNames(cluster.name),
                          ),
                        )
                        .map((cluster) => ({
                          cluster,
                          enterpriseId,
                          pageId: page.id ?? "",
                        })),
                    ),
                  )
                : Effect.succeed(
                    [] as Array<{
                      cluster: androidenterprise.StoreCluster;
                      enterpriseId: string;
                      pageId: string;
                    }>,
                  ),
            { concurrency: 4 },
          );
          return clusters.flat();
        }),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedWebapps = () =>
  Effect.gen(function* () {
    const enterpriseIds = yield* listEnterpriseIds();
    const pages = yield* Effect.forEach(
      enterpriseIds,
      (enterpriseId) =>
        listWebappsAt(enterpriseId).pipe(
          Effect.map((items) =>
            items
              .filter((webapp) => hasOwnershipMarker(webapp.title))
              .map((webapp) => ({ webapp, enterpriseId })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });
