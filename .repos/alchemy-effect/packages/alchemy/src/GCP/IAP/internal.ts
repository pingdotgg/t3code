import * as iap from "@distilled.cloud/gcp/iap_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DEST_GROUP_ID_LENGTH = 63;
export const MIN_DEST_GROUP_ID_LENGTH = 4;
export const MAX_DISPLAY_NAME_LENGTH = 255;
export const OWNER_ZONE = "alc.invalid";

const DIGIT_TO_LETTER = "abcdefghij";

const emptyList = <A>() => Effect.succeed([] as A[]);

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) => {
  const a = [...(left ?? [])].map((value) => value.toLowerCase()).sort();
  const b = [...(right ?? [])].map((value) => value.toLowerCase()).sort();
  return JSON.stringify(a) === JSON.stringify(b);
};

export const uniqueStrings = (values: readonly string[] | undefined) => {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(trimmed);
  }
  return next;
};

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const projectParent = (project: string) => `projects/${project}`;

export const destGroupParent = (project: string, location: string) =>
  `projects/${project}/iap_tunnel/locations/${location}`;

export const destGroupNameOf = (
  project: string,
  location: string,
  destGroupId: string,
) => {
  if (destGroupId.includes("/destGroups/")) {
    return destGroupId.replace(/\/+$/, "");
  }
  return `${destGroupParent(project, location)}/destGroups/${lastSegment(destGroupId)}`;
};

export const parseDestGroupName = (
  name: string,
  fallbackProject: string,
  fallbackLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const destAt = parts.lastIndexOf("destGroups");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : fallbackProject,
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    destGroupId:
      destAt >= 0 && parts[destAt + 1] ? parts[destAt + 1]! : lastSegment(name),
  };
};

export const parseClientName = (name: string, fallbackProject: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const clientsAt = parts.lastIndexOf("identityAwareProxyClients");
  const brandsAt = parts.lastIndexOf("brands");
  const projectsAt = parts.lastIndexOf("projects");
  const project =
    projectsAt >= 0 && parts[projectsAt + 1]
      ? parts[projectsAt + 1]!
      : fallbackProject;
  const brandId =
    brandsAt >= 0 && parts[brandsAt + 1] ? parts[brandsAt + 1]! : "";
  return {
    project,
    brandId,
    brand: brandId.length > 0 ? `projects/${project}/brands/${brandId}` : "",
    identityAwareProxyClientId:
      clientsAt >= 0 && parts[clientsAt + 1]
        ? parts[clientsAt + 1]!
        : lastSegment(name),
  };
};

export const brandNameOf = (project: string, brand: string) => {
  const trimmed = brand.replace(/\/+$/, "");
  if (trimmed.includes("/brands/")) return trimmed;
  if (trimmed.startsWith("projects/")) return trimmed;
  return `projects/${project}/brands/${lastSegment(trimmed)}`;
};

const lettersOnly = (value: string) =>
  value
    .toLowerCase()
    .replace(/[0-9]/g, (digit) => DIGIT_TO_LETTER[Number(digit)] ?? "a")
    .replace(/[^a-z-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

export const toDestGroupId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return lastSegment(explicit).slice(0, MAX_DEST_GROUP_ID_LENGTH);
    }
    if (existing !== undefined && existing.length > 0) {
      return lastSegment(existing).slice(0, MAX_DEST_GROUP_ID_LENGTH);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_DEST_GROUP_ID_LENGTH,
      lowercase: true,
    });
    let next = lettersOnly(generated);
    if (!/^[a-z]/.test(next)) next = `d${next}`;
    next = next.slice(0, MAX_DEST_GROUP_ID_LENGTH).replace(/-$/g, "");
    if (next.length < MIN_DEST_GROUP_ID_LENGTH) {
      next = `${next}dest`.slice(0, MAX_DEST_GROUP_ID_LENGTH);
    }
    return next;
  });

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
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
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
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

export const ownershipFqdn = (labels: Record<string, string>) => {
  const raw = (labels[alchemyLabelKeys.id] ?? "x")
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `alc-${raw.length > 0 ? raw : "x"}.${OWNER_ZONE}`;
};

export const isOwnershipFqdn = (fqdn: string) =>
  fqdn.toLowerCase().endsWith(`.${OWNER_ZONE}`);

export const userFqdns = (fqdns: readonly string[] | undefined) =>
  uniqueStrings(fqdns).filter((fqdn) => !isOwnershipFqdn(fqdn));

export const hasOwnershipFqdn = (fqdns: readonly string[] | undefined) =>
  (fqdns ?? []).some((fqdn) => isOwnershipFqdn(fqdn));

export const ownedDestGroup = (
  id: string,
  fqdns: readonly string[] | undefined,
) =>
  Effect.gen(function* () {
    if (!hasOwnershipFqdn(fqdns)) return false;
    const expected = ownershipFqdn(yield* createInternalLabels(id));
    return (fqdns ?? []).some((fqdn) => {
      const lower = fqdn.toLowerCase();
      return lower === expected || prefixMatch(expected, lower);
    });
  });

export const desiredFqdns = (
  labels: Record<string, string>,
  fqdns: readonly string[] | undefined,
) => uniqueStrings([...userFqdns(fqdns), ownershipFqdn(labels)]);

export const toGeneratedDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 80,
      lowercase: true,
    });
    return generated;
  });

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousParent !== undefined &&
    input.nextParent !== undefined &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

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

const collectPages = <Page, Item, E extends { readonly _tag: string }, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => emptyList<Item>(),
    ),
  );

export const getDestGroup = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(iap.getProjectsIap_tunnelLocationsDestGroups({ name }));

export const getClient = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(iap.getProjectsBrandsIdentityAwareProxyClients({ name }));

export const listDestGroups = (project: string) =>
  collectPages(
    iap.listProjectsIap_tunnelLocationsDestGroups.pages({
      parent: destGroupParent(project, "-"),
      pageSize: 1000,
    }),
    (page) => page.tunnelDestGroups,
  );

export const listOwnedDestGroups = (project: string) =>
  listDestGroups(project).pipe(
    Effect.map((groups) =>
      groups.filter((group) => hasOwnershipFqdn(group.fqdns)),
    ),
  );

export const listBrands = (project: string) =>
  iap.listProjectsBrands({ parent: projectParent(project) }).pipe(
    Effect.map((page) => page.brands ?? []),
    Effect.catchTag("NotFound", () => emptyList<iap.Brand>()),
  );

export const listClients = (brand: string) =>
  brand.length === 0
    ? emptyList<iap.IdentityAwareProxyClient>()
    : collectPages(
        iap.listProjectsBrandsIdentityAwareProxyClients.pages({
          parent: brand,
          pageSize: 100,
        }),
        (page) => page.identityAwareProxyClients,
      );

export const listOwnedClients = (project: string) =>
  Effect.gen(function* () {
    const brands = yield* listBrands(project);
    const pages = yield* Effect.forEach(
      brands,
      (brand) =>
        brand.name
          ? listClients(brand.name)
          : emptyList<iap.IdentityAwareProxyClient>(),
      { concurrency: 4 },
    );
    return pages
      .flat()
      .filter((client) => hasOwnershipMarker(client.displayName));
  });

export const findOwnedClient = (
  project: string,
  id: string,
  brand: string | undefined,
  displayName: string | undefined,
) =>
  Effect.gen(function* () {
    const clients =
      brand !== undefined && brand.length > 0
        ? yield* listClients(brand)
        : yield* listOwnedClients(project);
    for (const client of clients) {
      if (!(yield* ownedByAlchemy(id, client.displayName))) continue;
      const parsed = parseOwnership(client.displayName);
      if (
        displayName !== undefined &&
        parsed.text !== undefined &&
        parsed.text !== displayName
      ) {
        continue;
      }
      return client;
    }
    return undefined;
  });

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.IAP.DeleteNotConfirmed",
)<{}> {}

/** Poll until the resource is gone; fails if it is still readable after ~60s. */
export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value === undefined,
      times: 30,
    }),
    Effect.flatMap((value): Effect.Effect<void, DeleteNotConfirmed> =>
      value === undefined ? Effect.void : Effect.fail(new DeleteNotConfirmed()),
    ),
  );
