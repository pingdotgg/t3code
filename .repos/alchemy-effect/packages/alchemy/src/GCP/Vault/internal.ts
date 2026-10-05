import * as vault from "@distilled.cloud/gcp/vault_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_MATTER_NAME_LENGTH = 100;
export const MAX_HOLD_NAME_LENGTH = 100;
export const MAX_EXPORT_NAME_LENGTH = 100;
export const MAX_SAVED_QUERY_NAME_LENGTH = 100;

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

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = fitMarker(labels, 8000);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_HOLD_NAME_LENGTH,
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

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
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
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `v${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export const getMatter = (matterId: string) =>
  matterId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(vault.getMatters({ matterId, view: "FULL" }));

export const listMatters = () =>
  vault.listMatters.pages({ pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.matters ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => emptyList<vault.Matter>()),
  );

export const listActiveMatters = () =>
  listMatters().pipe(
    Effect.map((matters) =>
      matters.filter(
        (matter) =>
          matter.state !== "DELETED" && (matter.matterId ?? "").length > 0,
      ),
    ),
  );

export const findOwnedMatter = (id: string) =>
  Effect.gen(function* () {
    const matters = yield* listMatters();
    for (const matter of matters) {
      if (yield* ownedByAlchemy(id, matter.description)) {
        return matter;
      }
    }
    return undefined;
  });

export const closeThenDeleteMatter = (matterId: string) =>
  Effect.gen(function* () {
    if (matterId.length === 0) return;
    const current = yield* getMatter(matterId);
    if (current === undefined || current.state === "DELETED") return;
    if (current.state === "OPEN") {
      yield* vault.closeMatters({ matterId, body: {} }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("BadRequest", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
      );
    }
    yield* vault.deleteMatters({ matterId }).pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.catchTag("BadRequest", () => Effect.void),
      Effect.catchTag("Conflict", () => Effect.void),
    );
  });

export const getHold = (matterId: string, holdId: string) =>
  matterId.length === 0 || holdId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        vault.getMattersHolds({
          matterId,
          holdId,
          view: "FULL_HOLD",
        }),
      );

export const listHolds = (matterId: string) =>
  matterId.length === 0
    ? emptyList<vault.Hold>()
    : vault.listMattersHolds
        .pages({ matterId, pageSize: 100, view: "FULL_HOLD" })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.holds ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<vault.Hold>()),
        );

export const findHoldByName = (matterId: string, name: string) =>
  listHolds(matterId).pipe(
    Effect.map((holds) => holds.find((hold) => hold.name === name)),
  );

export const findOwnedHold = (id: string, matterId?: string) =>
  Effect.gen(function* () {
    const parents =
      matterId !== undefined && matterId.length > 0
        ? [{ matterId }]
        : yield* listActiveMatters();
    for (const parent of parents) {
      const parentId = parent.matterId ?? "";
      const holds = yield* listHolds(parentId);
      for (const hold of holds) {
        if (yield* ownedByAlchemy(id, hold.name)) {
          return { hold, matterId: parentId };
        }
      }
    }
    return undefined;
  });

export const getExport = (matterId: string, exportId: string) =>
  matterId.length === 0 || exportId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(vault.getMattersExports({ matterId, exportId }));

export const listExports = (matterId: string) =>
  matterId.length === 0
    ? emptyList<vault.Export>()
    : vault.listMattersExports.pages({ matterId, pageSize: 100 }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.exports ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => emptyList<vault.Export>()),
      );

export const findExportByName = (matterId: string, name: string) =>
  listExports(matterId).pipe(
    Effect.map((items) => items.find((item) => item.name === name)),
  );

export const findOwnedExport = (id: string, matterId?: string) =>
  Effect.gen(function* () {
    const parents =
      matterId !== undefined && matterId.length > 0
        ? [{ matterId }]
        : yield* listActiveMatters();
    for (const parent of parents) {
      const parentId = parent.matterId ?? "";
      const items = yield* listExports(parentId);
      for (const item of items) {
        if (yield* ownedByAlchemy(id, item.name)) {
          return item;
        }
      }
    }
    return undefined;
  });

export const getSavedQuery = (matterId: string, savedQueryId: string) =>
  matterId.length === 0 || savedQueryId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(vault.getMattersSavedQueries({ matterId, savedQueryId }));

export const listSavedQueries = (matterId: string) =>
  matterId.length === 0
    ? emptyList<vault.SavedQuery>()
    : vault.listMattersSavedQueries.pages({ matterId, pageSize: 100 }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.savedQueries ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => emptyList<vault.SavedQuery>()),
      );

export const findSavedQueryByName = (matterId: string, displayName: string) =>
  listSavedQueries(matterId).pipe(
    Effect.map((items) =>
      items.find((item) => item.displayName === displayName),
    ),
  );

export const findOwnedSavedQuery = (id: string, matterId?: string) =>
  Effect.gen(function* () {
    const parents =
      matterId !== undefined && matterId.length > 0
        ? [{ matterId }]
        : yield* listActiveMatters();
    for (const parent of parents) {
      const parentId = parent.matterId ?? "";
      const items = yield* listSavedQueries(parentId);
      for (const item of items) {
        if (yield* ownedByAlchemy(id, item.displayName)) {
          return item;
        }
      }
    }
    return undefined;
  });

export const accountKey = (account: vault.HeldAccount) =>
  (account.email ?? account.accountId ?? "").toLowerCase();

export const sameAccounts = (
  left: readonly vault.HeldAccount[] | undefined,
  right: readonly vault.HeldAccount[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].map(accountKey).filter(Boolean).sort(),
    [...(right ?? [])].map(accountKey).filter(Boolean).sort(),
  );

export const sameOrgUnit = (
  left: vault.HeldOrgUnit | undefined,
  right: vault.HeldOrgUnit | undefined,
) => sameText(left?.orgUnitId, right?.orgUnitId);

export const desiredAccounts = (
  accounts: readonly vault.HeldAccount[] | undefined,
): vault.HeldAccount[] | undefined => {
  if (accounts === undefined) return undefined;
  return accounts.map((account) => ({
    email: account.email,
    accountId: account.accountId,
  }));
};
