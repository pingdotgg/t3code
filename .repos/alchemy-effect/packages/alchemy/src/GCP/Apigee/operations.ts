import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  orgIdOf,
  orgParent,
  parseDescription,
} from "./ownership.ts";

export {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  orgIdOf,
  orgParent,
  parseDescription,
};

export const orgNameOf = (organization: string) =>
  organization.startsWith("organizations/")
    ? organization
    : `organizations/${organization}`;

export const orgName = orgNameOf;

export const defaultOrgName = (project: string, organization?: string) =>
  orgNameOf(organization ?? project);

export const createOwnership = (id: string) => createInternalLabels(id);

export const ownedBy = (id: string, labels: Record<string, string>) =>
  hasAlchemyLabels(id, labels);

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const jsonEqual = sameJson;

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].sort();

export const sameRecord = (
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) => sameJson(left ?? {}, right ?? {});

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = 63,
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
    return generated.replace(/-+$/g, "") || "resource";
  });

export const letterPrefixedId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = 63,
) => toPhysicalId(id, explicit, existing, maxLength);

export const dcCollectorId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 28,
      lowercase: true,
    });
    const cleaned = generated.replace(/[^a-z0-9]/g, "_");
    return cleaned.startsWith("dc_") ? cleaned : `dc_${cleaned}`;
  });

export const collectPages = <Page, Item, E, R>(
  stream: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly Item[] | undefined,
) =>
  stream.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listOrgNames = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const page = yield* apigee
      .listOrganizations({ parent: "organizations" })
      .pipe(
        Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
          Effect.succeed({
            organizations:
              [] as apigee.GoogleCloudApigeeV1OrganizationProjectMappingList,
          }),
        ),
      );
    const mappings = (page.organizations ?? []).filter(
      (mapping) =>
        mapping.projectId === env.project ||
        (mapping.projectIds ?? []).includes(env.project),
    );
    const ids =
      mappings.length > 0
        ? mappings.map((mapping) => mapping.organization ?? env.project)
        : [env.project];
    return [...new Set(ids.map(orgNameOf))];
  });

export const resolveOrgId = (project: string) =>
  Effect.gen(function* () {
    const names = yield* listOrgNames();
    return orgIdOf(names[0] ?? project);
  });

export const childName = (parent: string, collection: string, id: string) =>
  `${parent}/${collection}/${lastSegment(id)}`;

const isAttributesObject = (
  value:
    | readonly apigee.GoogleCloudApigeeV1Attribute[]
    | apigee.GoogleCloudApigeeV1Attributes,
): value is apigee.GoogleCloudApigeeV1Attributes => !Array.isArray(value);

export const attributesToRecord = (
  attributes:
    | readonly apigee.GoogleCloudApigeeV1Attribute[]
    | apigee.GoogleCloudApigeeV1Attributes
    | undefined,
): Record<string, string> => {
  const list =
    attributes === undefined
      ? []
      : isAttributesObject(attributes)
        ? (attributes.attribute ?? [])
        : attributes;
  const record: Record<string, string> = {};
  for (const item of list) {
    if (item.name !== undefined) record[item.name] = item.value ?? "";
  }
  return record;
};

export const recordToAttributes = (
  record: Record<string, string>,
): apigee.GoogleCloudApigeeV1Attribute[] =>
  Object.entries(record).map(([name, value]) => ({ name, value }));

export const userAttributes = (record: Record<string, string> | undefined) =>
  Object.fromEntries(
    Object.entries(record ?? {}).filter(([key]) => !key.startsWith("alchemy-")),
  );

export const desiredAttributes = (
  user: Record<string, string> | undefined,
  ownership: Record<string, string>,
) => ({ ...(user ?? {}), ...ownership });

export const propertiesToRecord = (
  properties: apigee.GoogleCloudApigeeV1Properties | undefined,
): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const item of properties?.property ?? []) {
    if (item.name !== undefined) record[item.name] = item.value ?? "";
  }
  return record;
};

export const recordToProperties = (
  record: Record<string, string>,
): apigee.GoogleCloudApigeeV1Properties => ({
  property: Object.entries(record).map(([name, value]) => ({ name, value })),
});

export const userProperties = (
  properties: apigee.GoogleCloudApigeeV1Properties | undefined,
) => userAttributes(propertiesToRecord(properties));

/**
 * Wait for an Apigee long-running operation through the shared GCP waiter.
 * `notFoundOk` / `alreadyExistsOk` accept an operation that finished with
 * `NOT_FOUND` (5) / `ALREADY_EXISTS` (6).
 */
export const waitForOperation = (
  operation: apigee.GoogleLongrunningOperation,
  options?: {
    notFoundOk?: boolean;
    alreadyExistsOk?: boolean;
    budget?: Duration.Input;
  },
) => {
  let latest = operation;
  return waitForGcpOperation(
    operation,
    (name) =>
      apigee.getOrganizationsOperations({ name }).pipe(
        Effect.tap((current) =>
          Effect.sync(() => {
            latest = current;
          }),
        ),
        Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], (error) =>
          options?.notFoundOk === true
            ? Effect.succeed<apigee.GoogleLongrunningOperation>({
                name,
                done: true,
              })
            : Effect.fail(error),
        ),
      ),
    { budget: options?.budget ?? "10 minutes" },
  ).pipe(
    Effect.map(() => latest),
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        ((options?.notFoundOk === true && error.code === 5) ||
          (options?.alreadyExistsOk === true && error.code === 6)),
      () => Effect.succeed(latest),
    ),
  );
};

export const stringField = (
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const raw = value?.[key];
  return typeof raw === "string" ? raw : undefined;
};
