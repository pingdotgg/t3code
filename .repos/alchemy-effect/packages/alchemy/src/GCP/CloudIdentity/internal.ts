import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_CUSTOMER = "customers/my_customer";
export const DISCUSSION_FORUM_LABEL =
  "cloudidentity.googleapis.com/groups.discussion_forum";
export const MAX_DISPLAY_NAME_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 4096;
export const MAX_ASSET_TAG_LENGTH = 100;
export const MAX_GROUP_KEY_LOCAL_LENGTH = 32;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const normalizeCustomer = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return DEFAULT_CUSTOMER;
  }
  if (
    trimmed.startsWith("customers/") ||
    trimmed.startsWith("identitysources/")
  ) {
    return trimmed;
  }
  return `customers/${trimmed}`;
};

export const expandName = (value: string, collection: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/")) return trimmed;
  return `${collection}/${trimmed}`;
};

export const expandGroup = (value: string) => expandName(value, "groups");

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
  const marker = fitMarker(labels, Math.min(8000, MAX_DESCRIPTION_LENGTH));
  const trimmed = text?.trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
  return combined.slice(0, MAX_DESCRIPTION_LENGTH);
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

export const hasOwnershipMarker = (text: string | undefined) => {
  if (
    Object.keys(parseOwnership(text).labels).some((key) =>
      key.startsWith("alchemy-"),
    )
  ) {
    return true;
  }
  return (text ?? "").toLowerCase().includes("alchemy-");
};

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

export const toPhysicalId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_GROUP_KEY_LOCAL_LENGTH,
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

export const toGroupKeyId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  domain: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const local = yield* createPhysicalName({
      id,
      maxLength: MAX_GROUP_KEY_LOCAL_LENGTH,
      lowercase: true,
    });
    const host = domain?.trim();
    return host && host.length > 0 ? `${local}@${host}` : local;
  });

export const typeLabels = (
  labels: Record<string, string> | undefined,
): Record<string, string> => {
  const next = { ...(labels ?? {}) };
  if (Object.keys(next).length === 0) {
    next[DISCUSSION_FORUM_LABEL] = "";
  }
  return next;
};

export const compactStringMap = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1] !== undefined,
    ),
  );

const emptyList = <A>() => Effect.succeed([] as A[]);

export const getGroup = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudidentity
        .getGroups({ name: expandGroup(name) })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const lookupGroupName = (
  groupKeyId: string,
  namespace: string | undefined,
) =>
  groupKeyId.length === 0
    ? Effect.succeed(undefined)
    : cloudidentity
        .lookupGroups({
          "groupKey.id": groupKeyId,
          "groupKey.namespace": namespace,
        })
        .pipe(
          Effect.map((result) => result.name),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );

export const getGroupByKey = (
  groupKeyId: string,
  namespace: string | undefined,
) =>
  Effect.gen(function* () {
    const name = yield* lookupGroupName(groupKeyId, namespace);
    if (name === undefined) return undefined;
    return yield* getGroup(name);
  });

export const listGroups = (parent?: string) =>
  cloudidentity.listGroups
    .pages({
      parent: normalizeCustomer(parent),
      view: "FULL",
      pageSize: 200,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.groups ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<cloudidentity.Group>()),
    );

export const isOwnedGroup = (group: cloudidentity.Group) =>
  hasOwnershipMarker(group.description) ||
  hasOwnershipMarker(group.displayName);

export const listOwnedGroups = (parent?: string) =>
  listGroups(parent).pipe(Effect.map((groups) => groups.filter(isOwnedGroup)));

export const findOwnedGroup = (id: string, parent?: string) =>
  Effect.gen(function* () {
    const groups = yield* listGroups(parent);
    for (const group of groups) {
      if (
        (yield* ownedByAlchemy(id, group.description)) ||
        (yield* ownedByAlchemy(id, group.displayName))
      ) {
        return group;
      }
    }
    return undefined;
  });

export const getMembership = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudidentity
        .getGroupsMemberships({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const lookupMembershipName = (
  parent: string,
  memberKeyId: string,
  namespace: string | undefined,
) =>
  parent.length === 0 || memberKeyId.length === 0
    ? Effect.succeed(undefined)
    : cloudidentity
        .lookupGroupsMemberships({
          parent: expandGroup(parent),
          "memberKey.id": memberKeyId,
          "memberKey.namespace": namespace,
        })
        .pipe(
          Effect.map((result) => result.name),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );

export const getMembershipByKey = (
  parent: string,
  memberKeyId: string,
  namespace: string | undefined,
) =>
  Effect.gen(function* () {
    const name = yield* lookupMembershipName(parent, memberKeyId, namespace);
    if (name === undefined) return undefined;
    return yield* getMembership(name);
  });

export const listMemberships = (parent: string) =>
  parent.length === 0
    ? emptyList<cloudidentity.Membership>()
    : cloudidentity.listGroupsMemberships
        .pages({
          parent: expandGroup(parent),
          view: "FULL",
          pageSize: 200,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.memberships ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<cloudidentity.Membership>(),
          ),
        );

export const getDevice = (name: string, customer?: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudidentity
        .getDevices({
          name: expandName(name, "devices"),
          customer: customer ? normalizeCustomer(customer) : undefined,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listDevices = (customer?: string) =>
  cloudidentity.listDevices
    .pages({
      customer: normalizeCustomer(customer),
      view: "COMPANY_INVENTORY",
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.devices ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        emptyList<cloudidentity.GoogleAppsCloudidentityDevicesV1Device>(),
      ),
    );

export const findOwnedDevice = (
  id: string,
  serialNumber: string | undefined,
  customer?: string,
) =>
  Effect.gen(function* () {
    const devices = yield* listDevices(customer);
    for (const device of devices) {
      if (
        serialNumber !== undefined &&
        serialNumber.length > 0 &&
        sameText(device.serialNumber, serialNumber)
      ) {
        return device;
      }
      if (yield* ownedByAlchemy(id, device.assetTag)) {
        return device;
      }
    }
    return undefined;
  });

export const getOidcProfile = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudidentity
        .getInboundOidcSsoProfiles({
          name: expandName(name, "inboundOidcSsoProfiles"),
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listOidcProfiles = () =>
  cloudidentity.listInboundOidcSsoProfiles.pages({ pageSize: 100 }).pipe(
    Stream.flatMap((page) =>
      Stream.fromIterable(page.inboundOidcSsoProfiles ?? []),
    ),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      emptyList<cloudidentity.InboundOidcSsoProfile>(),
    ),
  );

export const findOwnedOidcProfile = (id: string) =>
  Effect.gen(function* () {
    const profiles = yield* listOidcProfiles();
    for (const profile of profiles) {
      if (yield* ownedByAlchemy(id, profile.displayName)) {
        return profile;
      }
    }
    return undefined;
  });

export const getSamlProfile = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudidentity
        .getInboundSamlSsoProfiles({
          name: expandName(name, "inboundSamlSsoProfiles"),
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listSamlProfiles = () =>
  cloudidentity.listInboundSamlSsoProfiles.pages({ pageSize: 100 }).pipe(
    Stream.flatMap((page) =>
      Stream.fromIterable(page.inboundSamlSsoProfiles ?? []),
    ),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      emptyList<cloudidentity.InboundSamlSsoProfile>(),
    ),
  );

export const findOwnedSamlProfile = (id: string) =>
  Effect.gen(function* () {
    const profiles = yield* listSamlProfiles();
    for (const profile of profiles) {
      if (yield* ownedByAlchemy(id, profile.displayName)) {
        return profile;
      }
    }
    return undefined;
  });

export const getSsoAssignment = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudidentity
        .getInboundSsoAssignments({
          name: expandName(name, "inboundSsoAssignments"),
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listSsoAssignments = () =>
  cloudidentity.listInboundSsoAssignments.pages({ pageSize: 100 }).pipe(
    Stream.flatMap((page) =>
      Stream.fromIterable(page.inboundSsoAssignments ?? []),
    ),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      emptyList<cloudidentity.InboundSsoAssignment>(),
    ),
  );

export const findSsoAssignment = (input: {
  name?: string;
  targetGroup?: string;
  targetOrgUnit?: string;
  ssoMode?: string;
}) =>
  Effect.gen(function* () {
    if (input.name !== undefined && input.name.length > 0) {
      const existing = yield* getSsoAssignment(input.name);
      if (existing !== undefined) return existing;
    }
    const assignments = yield* listSsoAssignments();
    return assignments.find((assignment) => {
      if (
        input.targetGroup !== undefined &&
        !sameText(assignment.targetGroup, expandGroup(input.targetGroup))
      ) {
        return false;
      }
      if (
        input.targetOrgUnit !== undefined &&
        !sameText(assignment.targetOrgUnit, input.targetOrgUnit)
      ) {
        return false;
      }
      if (
        input.ssoMode !== undefined &&
        !sameText(assignment.ssoMode, input.ssoMode)
      ) {
        return false;
      }
      return (
        input.targetGroup !== undefined || input.targetOrgUnit !== undefined
      );
    });
  });
