import * as essentialcontacts from "@distilled.cloud/gcp/essentialcontacts_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export type NotificationCategory =
  essentialcontacts.GoogleCloudEssentialcontactsV1ContactNotificationCategorySubscriptionsItemEnum;

export type DistilledContact =
  essentialcontacts.GoogleCloudEssentialcontactsV1Contact;

export const DEFAULT_LANGUAGE_TAG = "en-US";
export const DEFAULT_CATEGORIES: NotificationCategory[] = ["ALL"];
export const UPDATE_MASK = "notificationCategorySubscriptions,languageTag";

const OWNERSHIP_TOKEN = "alc";
const MAX_LOCAL_PART = 64;

export class FolderRequired extends Data.TaggedError(
  "GCP.EssentialContacts.FolderRequired",
)<{
  project: string;
}> {}

export class OrganizationRequired extends Data.TaggedError(
  "GCP.EssentialContacts.OrganizationRequired",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOfName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf("contacts");
  if (index <= 0) return "";
  return parts.slice(0, index).join("/");
};

export const contactIdOf = (name: string) => lastSegment(name);

export const projectParent = (project: string) =>
  project.startsWith("projects/") ? project : `projects/${project}`;

export const folderParent = (folderId: string) =>
  folderId.startsWith("folders/")
    ? folderId
    : `folders/${lastSegment(folderId)}`;

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const normalizeEmail = (email: string | undefined) =>
  (email ?? "").trim().toLowerCase();

export const sortedCategories = (
  values: readonly string[] | undefined,
): NotificationCategory[] =>
  [...(values ?? [])]
    .map((value) => value as NotificationCategory)
    .slice()
    .sort();

export const sameCategories = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedCategories(left)) ===
  JSON.stringify(sortedCategories(right));

const markerOf = (stack: string, stage: string, id: string) =>
  `${OWNERSHIP_TOKEN}.${stack}.${stage}.${id}`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
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

const splitEmail = (email: string) => {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return { local: trimmed, domain: "" };
  return { local: trimmed.slice(0, at), domain: trimmed.slice(at + 1) };
};

const stripOwnershipLocal = (local: string) => {
  const token = `+${OWNERSHIP_TOKEN}.`;
  const index = local.lastIndexOf(token);
  return index >= 0 ? local.slice(0, index) : local;
};

/**
 * Essential Contacts have no labels or description, so Alchemy stamps
 * ownership into the email local-part as `+alc.{stack}.{stage}.{id}`.
 */
export const encodeEmail = (
  labels: Record<string, string>,
  email: string,
): string => {
  const { local, domain } = splitEmail(email);
  if (domain.length === 0) return email.trim();
  const base = stripOwnershipLocal(local);
  const reserved = base.length + 1;
  const marker = fitMarker(labels, Math.max(8, MAX_LOCAL_PART - reserved));
  const next = `${base}+${marker}`.slice(0, MAX_LOCAL_PART);
  return `${next}@${domain}`;
};

export const parseEmail = (
  email: string | undefined,
): {
  labels: Record<string, string>;
  email: string | undefined;
} => {
  if (!email) return { labels: {}, email };
  const { local, domain } = splitEmail(email);
  const token = `+${OWNERSHIP_TOKEN}.`;
  const index = local.lastIndexOf(token);
  if (index < 0) return { labels: {}, email };
  const tag = local.slice(index + token.length);
  const [stack, stage, ...idParts] = tag.split(".");
  const base = local.slice(0, index);
  const restored =
    domain.length > 0 ? `${base}@${domain}` : base.length > 0 ? base : email;
  return {
    labels: {
      [alchemyLabelKeys.stack]: stack ?? "",
      [alchemyLabelKeys.stage]: stage ?? "",
      [alchemyLabelKeys.id]: idParts.join("."),
    },
    email: restored,
  };
};

export const hasOwnershipMarker = (email: string | undefined) =>
  Object.keys(parseEmail(email).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, email: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseEmail(email);
    if (!hasOwnershipMarker(email)) return false;
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

export const toEmail = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 32,
      lowercase: true,
    });
    const local = generated.replace(/[^a-z0-9]/g, "").slice(0, 32) || "alchemy";
    return `${local}@example.com`;
  });

export const toCreateBody = (args: {
  email: string;
  languageTag: string;
  notificationCategorySubscriptions: NotificationCategory[];
}): DistilledContact => ({
  email: args.email,
  languageTag: args.languageTag,
  notificationCategorySubscriptions: args.notificationCategorySubscriptions,
});

export type ContactCoreAttrs = {
  name: string;
  contactId: string;
  parent: string;
  project: string;
  email: string;
  languageTag: string;
  notificationCategorySubscriptions: NotificationCategory[];
  validationState: string | undefined;
  validateTime: string | undefined;
};

export const toCoreAttrs = (
  contact: DistilledContact,
  parent: string,
  project: string,
): ContactCoreAttrs => {
  const name = contact.name ?? "";
  const parsed = parseEmail(contact.email);
  return {
    name,
    contactId: contactIdOf(name),
    parent: parentOfName(name) || parent,
    project,
    email: parsed.email ?? contact.email ?? "",
    languageTag: contact.languageTag ?? DEFAULT_LANGUAGE_TAG,
    notificationCategorySubscriptions: sortedCategories(
      contact.notificationCategorySubscriptions,
    ),
    validationState: contact.validationState,
    validateTime: contact.validateTime,
  };
};

export const findOwnedContact = (
  contacts: readonly DistilledContact[],
  id: string,
  name?: string,
  email?: string,
) =>
  Effect.gen(function* () {
    if (name) {
      const exact = contacts.find((contact) => contact.name === name);
      if (exact !== undefined) return exact;
    }
    const desired = email
      ? normalizeEmail(parseEmail(email).email ?? email)
      : undefined;
    let owned: DistilledContact | undefined;
    for (const contact of contacts) {
      if (!(yield* ownedByAlchemy(id, contact.email))) continue;
      const observed = normalizeEmail(
        parseEmail(contact.email).email ?? contact.email ?? "",
      );
      if (desired !== undefined) {
        if (observed === desired) return contact;
        continue;
      }
      if (owned === undefined) owned = contact;
    }
    return desired !== undefined ? undefined : owned;
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

export const listContacts = <E extends { readonly _tag: string }, R>(
  pages: Stream.Stream<
    essentialcontacts.GoogleCloudEssentialcontactsV1ListContactsResponse,
    E,
    R
  >,
) =>
  collectPages(pages, (page) => page.contacts).pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => emptyList<DistilledContact>(),
    ),
  );

const parentOfResource = (name: string) =>
  name.startsWith("projects/")
    ? resourcemanager.getProjects({ name }).pipe(
        Effect.map((resource) => resource.parent),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      )
    : name.startsWith("folders/")
      ? resourcemanager.getFolders({ name }).pipe(
          Effect.map((folder) => folder.parent),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        )
      : Effect.succeed(undefined);

export const lookupProjectFolderId = (project: string) =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((resource) => {
      const parent = resource.parent ?? "";
      return parent.startsWith("folders/") ? lastSegment(parent) : undefined;
    }),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const tryResolveFolder = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const folderId = yield* lookupProjectFolderId(env.project);
    return folderId !== undefined ? folderParent(folderId) : undefined;
  });

export const resolveFolder = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return folderParent(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return folderParent(existing);
    }
    const resolved = yield* tryResolveFolder();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new FolderRequired({ project: env.project });
    }
    return resolved;
  });

export const listFolderParents = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const ids = new Set<string>();
    const fromProject = yield* lookupProjectFolderId(env.project);
    if (fromProject !== undefined) ids.add(folderParent(fromProject));
    return [...ids];
  });

export const tryResolveOrganization = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("organizations/")) return current;
      current = yield* parentOfResource(current);
    }
    return undefined;
  });

export const resolveOrganization = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return organizationParent(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return organizationParent(existing);
    }
    const resolved = yield* tryResolveOrganization();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new OrganizationRequired({ project: env.project });
    }
    return resolved;
  });

export const listOrganizationParents = () =>
  Effect.gen(function* () {
    const resolved = yield* tryResolveOrganization();
    return resolved === undefined ? [] : [resolved];
  });

export const desiredLanguage = (value: string | undefined) =>
  value && value.length > 0 ? value : DEFAULT_LANGUAGE_TAG;

export const desiredCategories = (
  values: readonly NotificationCategory[] | undefined,
) =>
  values !== undefined && values.length > 0
    ? sortedCategories(values)
    : DEFAULT_CATEGORIES;
