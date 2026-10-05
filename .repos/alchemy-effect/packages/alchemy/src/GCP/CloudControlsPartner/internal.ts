import * as cloudcontrolspartner from "@distilled.cloud/gcp/cloudcontrolspartner_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 128;
export const LIST_LOCATIONS = ["global", "-"] as const;

export class OrganizationNotResolved extends Data.TaggedError(
  "GCP.CloudControlsPartner.OrganizationNotResolved",
)<{
  project: string;
}> {}

export class CustomerIdRequired extends Data.TaggedError(
  "GCP.CloudControlsPartner.CustomerIdRequired",
)<{
  id: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeName = (value: string) => value.replace(/\/+$/, "");

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? `organizations/${lastSegment(value.split("/locations/")[0] ?? value)}`
    : `organizations/${lastSegment(value)}`;

export const organizationIdOf = (value: string) =>
  lastSegment(organizationParent(value));

export const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

export const locationParent = (organization: string, location: string) =>
  `${organizationParent(organization)}/locations/${normalizeLocation(location)}`;

export const customerName = (
  organization: string,
  location: string,
  customerId: string,
) => `${locationParent(organization, location)}/customers/${customerId}`;

export const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const orgsAt = parts.lastIndexOf("organizations");
  const locationsAt = parts.lastIndexOf("locations");
  const customersAt = parts.lastIndexOf("customers");
  return {
    organization:
      orgsAt >= 0 && parts[orgsAt + 1]
        ? `organizations/${parts[orgsAt + 1]}`
        : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    customerId:
      customersAt >= 0 && parts[customersAt + 1]
        ? parts[customersAt + 1]!
        : lastSegment(name),
    parent:
      customersAt > 0
        ? parts.slice(0, customersAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const toCustomerId = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const trimmed = normalizeName(value);
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("/customers/")) return lastSegment(trimmed);
  return lastSegment(trimmed);
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const replaceOn = (
  previous: string | undefined,
  next: string | undefined,
) =>
  previous !== undefined && next !== undefined && previous !== next
    ? ({ action: "replace" as const, deleteFirst: false } as const)
    : undefined;

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
  });

export const toCustomerResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    const explicit = toCustomerId(requested);
    if (explicit !== undefined) return explicit;
    const previous = toCustomerId(existing);
    if (previous !== undefined) return previous;
    return yield* new CustomerIdRequired({ id });
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

export const encodeDisplayName = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const reserved = Math.min(trimmed.length + 1, Math.max(0, maxLength - 24));
  const marker = fitMarker(labels, Math.max(24, maxLength - reserved));
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

const ancestryParent = (name: string) =>
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

/** Organization from the ConfigProvider (env by default), if configured. */
const configuredOrganization = () =>
  Effect.gen(function* () {
    for (const key of [
      "GOOGLE_CLOUDCONTROLSPARTNER_ORGANIZATION",
      "GOOGLE_ORGANIZATION_ID",
    ]) {
      const raw = Option.getOrUndefined(
        yield* Config.option(Config.String(key)),
      )?.trim();
      if (raw) return organizationParent(raw);
    }
    return undefined;
  });

export const tryResolveOrganization = () =>
  Effect.gen(function* () {
    const configured = yield* configuredOrganization();
    if (configured !== undefined) return configured;
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("organizations/")) return current;
      current = yield* ancestryParent(current);
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
      return yield* new OrganizationNotResolved({ project: env.project });
    }
    return resolved;
  });

export const listLocationParents = (organization: string, region: string) =>
  [...new Set([region, ...LIST_LOCATIONS])].map((location) =>
    locationParent(organization, location),
  );

const emptyCustomers = () =>
  Effect.succeed([] as cloudcontrolspartner.Customer[]);

export const listCustomers = (parent: string) =>
  parent.length === 0
    ? emptyCustomers()
    : cloudcontrolspartner.listOrganizationsLocationsCustomers
        .pages({ parent, pageSize: 100 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.customers ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyCustomers()),
        );

export const getCustomer = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudcontrolspartner
        .getOrganizationsLocationsCustomers({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const findOwnedCustomer = (id: string, parent: string) =>
  Effect.gen(function* () {
    const customers = yield* listCustomers(parent);
    for (const customer of customers) {
      if (yield* ownedByAlchemy(id, customer.displayName)) {
        return customer;
      }
    }
    return undefined;
  });
