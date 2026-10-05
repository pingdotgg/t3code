import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as orgpolicy from "@distilled.cloud/gcp/orgpolicy_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const CUSTOM_PREFIX = "custom.";
const COLLECTION = "/customConstraints/";
const DESCRIPTION_MAX = 2000;
const GENERATED_ID_MAX = 60;

export type CustomConstraintMethodType =
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "REMOVE_GRANT"
  | "GOVERN_TAGS";

export type CustomConstraintActionType = "ALLOW" | "DENY";

export type CustomConstraintProps = {
  /**
   * Constraint id (the `{customConstraint}` segment of
   * `organizations/{organization}/customConstraints/{customConstraint}`).
   * Must start with `custom.` and contain only letters, digits, and
   * periods. If omitted, a unique id is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the constraint.
   */
  constraintId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project's Resource Manager ancestor. Immutable — changing it replaces the constraint.
   */
  organization?: string;
  /**
   * Resource types this constraint applies to, e.g.
   * `compute.googleapis.com/Instance`. Immutable — changing the set
   * replaces the constraint.
   */
  resourceTypes: string[];
  /**
   * Operations the constraint evaluates (`CREATE`, `UPDATE`, `DELETE`,
   * `REMOVE_GRANT`, `GOVERN_TAGS`).
   */
  methodTypes: CustomConstraintMethodType[];
  /**
   * CEL condition evaluated against the resource. Max 1000 characters.
   */
  condition: string;
  /**
   * Whether matching resources are allowed or denied.
   */
  actionType: CustomConstraintActionType;
  /**
   * One-line display name (max 200 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 2000 characters including the
   * Alchemy ownership prefix). Custom constraints have no labels, so
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  description?: string;
};

export type CustomConstraint = Resource<
  "GCP.OrgPolicy.CustomConstraint",
  CustomConstraintProps,
  {
    /** Full resource name `organizations/{organization}/customConstraints/{id}`. */
    name: string;
    /** Constraint id (last path segment, including the `custom.` prefix). */
    constraintId: string;
    /** Parent `organizations/{organization}`. */
    organization: string;
    /** Numeric organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Resource types this constraint applies to. */
    resourceTypes: string[];
    /** Operations the constraint evaluates. */
    methodTypes: string[];
    /** CEL condition. */
    condition: string;
    /** `ALLOW` or `DENY`. */
    actionType: string;
    /** One-line display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Organization Policy custom constraint.
 *
 * Custom constraints can only be created on an organization. Creating one
 * does not enforce anything — attach a `GCP.OrgPolicy.Policy` that
 * references the constraint id to enforce it.
 *
 * Custom constraints have no labels. Alchemy stamps ownership into the
 * description (`[alchemy alchemy-stack=… alchemy-stage=… alchemy-id=…]`)
 * so `list` / `pnpm nuke:gcp` can find them.
 *
 * `constraintId`, `organization`, and `resourceTypes` are immutable —
 * changing them replaces the constraint. `methodTypes`, `condition`,
 * `actionType`, `displayName`, and `description` update in place.
 *
 * ### Creating a Custom Constraint
 * **Example:** Deny matching Compute instances
 * ```typescript
 * const constraint = yield* GCP.OrgPolicy.CustomConstraint("NoTestVms", {
 *   resourceTypes: ["compute.googleapis.com/Instance"],
 *   methodTypes: ["CREATE"],
 *   condition: "resource.name.startsWith('test-')",
 *   actionType: "DENY",
 *   displayName: "Deny test VMs",
 * });
 * ```
 *
 * **Example:** Named constraint on an explicit organization
 * ```typescript
 * const constraint = yield* GCP.OrgPolicy.CustomConstraint("NoTestVms", {
 *   constraintId: "custom.denyTestVms",
 *   organization: "organizations/123456789",
 *   resourceTypes: ["compute.googleapis.com/Instance"],
 *   methodTypes: ["CREATE", "UPDATE"],
 *   condition: "resource.name.startsWith('test-')",
 *   actionType: "DENY",
 *   displayName: "Deny test VMs",
 *   description: "blocks test-prefixed instances",
 * });
 * ```
 *
 * ### Updating a Custom Constraint
 * **Example:** Broaden methods and change the condition
 * ```typescript
 * const constraint = yield* GCP.OrgPolicy.CustomConstraint("NoTestVms", {
 *   constraintId: "custom.denyTestVms",
 *   resourceTypes: ["compute.googleapis.com/Instance"],
 *   methodTypes: ["CREATE", "UPDATE"],
 *   condition: "resource.name.startsWith('tmp-')",
 *   actionType: "DENY",
 *   displayName: "Deny tmp VMs",
 * });
 * ```
 *
 * @resource
 * @category OrgPolicy
 */
export const CustomConstraint = Resource<CustomConstraint>(
  "GCP.OrgPolicy.CustomConstraint",
);

export class CustomConstraintNotResolved extends Data.TaggedError(
  "GCP.OrgPolicy.CustomConstraintNotResolved",
)<{
  name: string;
}> {}

export class OrganizationRequired extends Data.TaggedError(
  "GCP.OrgPolicy.OrganizationRequired",
)<{
  project: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

const constraintIdOf = (value: string) => {
  const at = value.indexOf(COLLECTION);
  return at >= 0 ? value.slice(at + COLLECTION.length) : lastSegment(value);
};

const normalizeConstraintId = (value: string) => {
  const id = constraintIdOf(value);
  return id.startsWith(CUSTOM_PREFIX) ? id : `${CUSTOM_PREFIX}${id}`;
};

const resourceName = (organization: string, constraintId: string) =>
  `${organization}${COLLECTION}${constraintId}`;

const parseName = (name: string) => {
  const at = name.indexOf(COLLECTION);
  if (at < 0) {
    return { organization: "", constraintId: normalizeConstraintId(name) };
  }
  return {
    organization: name.slice(0, at),
    constraintId: name.slice(at + COLLECTION.length),
  };
};

const sameOrganization = (
  left: string | undefined,
  right: string | undefined,
) => {
  if (left === undefined || right === undefined) return left === right;
  return organizationParent(left) === organizationParent(right);
};

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));

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

const tryResolveOrganization = (explicit?: string) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return organizationParent(explicit);
    }
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("organizations/")) return current;
      current = yield* parentOfResource(current);
    }
    return undefined;
  });

const resolveOrganization = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    const resolved = yield* tryResolveOrganization(explicit ?? existing);
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new OrganizationRequired({ project: env.project });
    }
    return resolved;
  });

const toConstraintId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return normalizeConstraintId(explicit);
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: GENERATED_ID_MAX,
      lowercase: true,
      delimiter: ".",
    });
    const body = generated.replace(/[^a-z0-9.]/g, "").replace(/^\.+|\.+$/g, "");
    return `${CUSTOM_PREFIX}${body.length > 0 ? body : "c"}`;
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  if (!description) return marker.slice(0, DESCRIPTION_MAX);
  const sep = "\n";
  const budget = DESCRIPTION_MAX - marker.length - sep.length;
  if (budget <= 0) return marker.slice(0, DESCRIPTION_MAX);
  return `${marker}${sep}${description.slice(0, budget)}`;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toAttrs = (
  constraint: orgpolicy.GoogleCloudOrgpolicyV2CustomConstraint,
  project: string,
) => {
  const name = constraint.name ?? "";
  const parsedName = parseName(name);
  const parsed = parseDescription(constraint.description);
  return {
    name,
    constraintId: parsedName.constraintId,
    organization: parsedName.organization,
    organizationId: lastSegment(parsedName.organization),
    project,
    resourceTypes: [...(constraint.resourceTypes ?? [])],
    methodTypes: [...(constraint.methodTypes ?? [])],
    condition: constraint.condition ?? "",
    actionType: constraint.actionType ?? "",
    displayName: constraint.displayName,
    description: parsed.description,
    updateTime: constraint.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : orgpolicy
        .getOrganizationsCustomConstraints({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listCustomConstraints = (parent: string) =>
  Effect.gen(function* () {
    const found: orgpolicy.GoogleCloudOrgpolicyV2CustomConstraint[] = [];
    let pageToken: string | undefined;
    do {
      const response = yield* orgpolicy.listOrganizationsCustomConstraints({
        parent,
        pageSize: 1000,
        pageToken,
      });
      found.push(...(response.customConstraints ?? []));
      pageToken = response.nextPageToken;
    } while (pageToken !== undefined && pageToken !== "");
    return found;
  }).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as orgpolicy.GoogleCloudOrgpolicyV2CustomConstraint[]),
    ),
  );

const toBody = (
  name: string,
  news: CustomConstraintProps,
  description: string,
  resourceTypes: readonly string[],
): orgpolicy.GoogleCloudOrgpolicyV2CustomConstraint => ({
  name,
  resourceTypes: [...resourceTypes],
  methodTypes: [...news.methodTypes],
  condition: news.condition,
  actionType: news.actionType,
  displayName: news.displayName,
  description,
});

export const CustomConstraintProvider = () =>
  Provider.succeed(CustomConstraint, {
    stables: [
      "name",
      "constraintId",
      "organization",
      "organizationId",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.constraintId ?? output?.constraintId;
      const nextId =
        news.constraintId !== undefined
          ? normalizeConstraintId(news.constraintId)
          : previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        previousId !== nextId;

      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        news.organization !== undefined &&
        previousOrg !== undefined &&
        !sameOrganization(news.organization, previousOrg);

      const previousTypes = olds?.resourceTypes ?? output?.resourceTypes;
      const typesChanged =
        news.resourceTypes !== undefined &&
        previousTypes !== undefined &&
        !sameStringList(news.resourceTypes, previousTypes);

      if (!idChanged && !orgChanged && !typesChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: !idChanged && !orgChanged,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* tryResolveOrganization(
        olds?.organization ?? output?.organization,
      );
      const constraintId = yield* toConstraintId(
        id,
        olds?.constraintId,
        output?.constraintId,
      );
      const name =
        output?.name ??
        (organization !== undefined
          ? resourceName(organization, constraintId)
          : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const constraints = yield* listCustomConstraints(organization);
        return constraints
          .filter((constraint) => hasOwnershipMarker(constraint.description))
          .map((constraint) => toAttrs(constraint, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const constraintId = yield* toConstraintId(
        id,
        news.constraintId,
        output?.constraintId,
      );
      const name = output?.name ?? resourceName(organization, constraintId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredTypes = [...news.resourceTypes];

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* orgpolicy
          .createOrganizationsCustomConstraints({
            parent: organization,
            body: toBody(
              resourceName(organization, constraintId),
              news,
              desiredDescription,
              desiredTypes,
            ),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomConstraintNotResolved({ name });
      }

      const methodsChanged = !sameStringList(
        current.methodTypes,
        news.methodTypes,
      );
      const conditionChanged = (current.condition ?? "") !== news.condition;
      const actionChanged = (current.actionType ?? "") !== news.actionType;
      const displayChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;

      if (
        methodsChanged ||
        conditionChanged ||
        actionChanged ||
        displayChanged ||
        descriptionChanged
      ) {
        current = yield* orgpolicy
          .patchOrganizationsCustomConstraints({
            name: current.name ?? name,
            body: toBody(
              current.name ?? name,
              news,
              desiredDescription,
              current.resourceTypes ?? desiredTypes,
            ),
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.exponential("200 millis"),
            }),
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* orgpolicy
        .deleteOrganizationsCustomConstraints({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
