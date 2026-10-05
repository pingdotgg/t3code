import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  encodeOwnershipLine,
  jsonEqual,
  listOwnedPolicies,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  policyNameOf,
  replaceOnIdentity,
  resourceNameOf,
  toAcmId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type ServicePerimeterConfig = acm.ServicePerimeterConfig;
export type ServicePerimeterType = acm.ServicePerimeterPerimeterTypeEnum;

export type AccessPoliciesServicePerimeterProps = {
  /**
   * Parent access policy (`accessPolicies/{policy}` or the policy id).
   * Immutable — changing it replaces the perimeter.
   */
  policy: string;
  /**
   * Service perimeter id (the `{service_perimeter}` segment). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Must begin with a letter, then alphanumeric or `_`. Immutable —
   * changing it replaces the perimeter.
   */
  servicePerimeterId?: string;
  /**
   * Human-readable title. Must be unique within the policy.
   */
  title?: string;
  /**
   * Description of the perimeter. Service perimeters have no labels, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Perimeter type. Immutable — changing it replaces the perimeter.
   * @default "PERIMETER_TYPE_REGULAR"
   */
  perimeterType?: ServicePerimeterType | (string & {});
  /**
   * When true, `spec` is an explicit dry-run configuration instead of an
   * implicit copy of `status`.
   * @default false
   */
  useExplicitDryRunSpec?: boolean;
  /**
   * Enforced perimeter configuration (resources, restricted services,
   * access levels, ingress/egress policies).
   */
  status?: ServicePerimeterConfig;
  /**
   * Proposed (dry-run) configuration. Only applied when
   * `useExplicitDryRunSpec` is true.
   */
  spec?: ServicePerimeterConfig;
};

export type AccessPoliciesServicePerimeter = Resource<
  "GCP.AccessContextManager.AccessPoliciesServicePerimeter",
  AccessPoliciesServicePerimeterProps,
  {
    /** Resource name `accessPolicies/{policy}/servicePerimeters/{perimeter}`. */
    name: string;
    /** Service perimeter id (last path segment). */
    servicePerimeterId: string;
    /** Parent policy name `accessPolicies/{policy}`. */
    policy: string;
    /** User title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Perimeter type. */
    perimeterType: string | undefined;
    /** Whether an explicit dry-run spec is in use. */
    useExplicitDryRunSpec: boolean;
    /** Enforced configuration. */
    status: ServicePerimeterConfig | undefined;
    /** Dry-run configuration. */
    spec: ServicePerimeterConfig | undefined;
    /** Server etag for optimistic concurrency. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Access Context Manager service perimeter.
 *
 * A service perimeter groups Google Cloud resources that can freely
 * exchange data with each other but not with the outside. Regular
 * perimeters cannot overlap; bridges can share projects.
 *
 * Service perimeters have no labels. Alchemy stamps ownership into
 * `description` so `list` / `pnpm nuke:gcp` can find them. `policy`,
 * `servicePerimeterId`, and `perimeterType` are immutable. Title,
 * description, `status`, `spec`, and `useExplicitDryRunSpec` update in
 * place.
 *
 * ### Creating a Service Perimeter
 * **Example:** Regular perimeter around Cloud Storage
 * ```typescript
 * const policy = yield* GCP.AccessContextManager.AccessPolicy("Corp", {
 *   scopes: ["projects/123456789"],
 * });
 * const perimeter = yield* GCP.AccessContextManager.AccessPoliciesServicePerimeter(
 *   "Storage",
 *   {
 *     policy: policy.name,
 *     title: "storage perimeter",
 *     status: {
 *       restrictedServices: ["storage.googleapis.com"],
 *     },
 *   },
 * );
 * ```
 *
 * ### Updating a Service Perimeter
 * **Example:** Restrict BigQuery as well
 * ```typescript
 * const perimeter = yield* GCP.AccessContextManager.AccessPoliciesServicePerimeter(
 *   "Storage",
 *   {
 *     policy: policy.name,
 *     title: "data perimeter",
 *     status: {
 *       restrictedServices: [
 *         "storage.googleapis.com",
 *         "bigquery.googleapis.com",
 *       ],
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category AccessContextManager
 */
export const AccessPoliciesServicePerimeter =
  Resource<AccessPoliciesServicePerimeter>(
    "GCP.AccessContextManager.AccessPoliciesServicePerimeter",
  );

export class AccessPoliciesServicePerimeterNotResolved extends Data.TaggedError(
  "GCP.AccessContextManager.AccessPoliciesServicePerimeterNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_TYPE = "PERIMETER_TYPE_REGULAR";

const typeOf = (value: string | undefined) => value ?? DEFAULT_TYPE;

const toAttrs = (
  perimeter: acm.ServicePerimeter,
): AccessPoliciesServicePerimeter["Attributes"] => {
  const name = perimeter.name ?? "";
  const parsed = parseName(name, "servicePerimeters");
  const title = parseOwnership(perimeter.title);
  const description = parseOwnership(perimeter.description);
  return {
    name,
    servicePerimeterId: parsed.id,
    policy: parsed.parent,
    title: title.text,
    description: description.text,
    perimeterType: perimeter.perimeterType,
    useExplicitDryRunSpec: perimeter.useExplicitDryRunSpec === true,
    status: perimeter.status,
    spec: perimeter.spec,
    etag: perimeter.etag,
  };
};

const getByName = (name: string) =>
  acm
    .getAccessPoliciesServicePerimeters({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPerimeters = (policy: string) =>
  collectPages(
    acm.listAccessPoliciesServicePerimeters.pages({
      parent: policyNameOf(policy),
      pageSize: 100,
    }),
    (page) => page.servicePerimeters,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as acm.ServicePerimeter[]),
    ),
  );

export const AccessPoliciesServicePerimeterProvider = () =>
  Provider.succeed(AccessPoliciesServicePerimeter, {
    stables: ["name", "servicePerimeterId", "policy", "perimeterType"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.servicePerimeterId ?? output?.servicePerimeterId;
      const idChanged =
        previousId !== undefined &&
        news.servicePerimeterId !== undefined &&
        news.servicePerimeterId !== previousId;
      const previousPolicy = olds?.policy ?? output?.policy;
      const policyChanged =
        previousPolicy !== undefined &&
        policyNameOf(news.policy) !== policyNameOf(previousPolicy);
      const previousType = typeOf(olds?.perimeterType ?? output?.perimeterType);
      const nextType = typeOf(
        news.perimeterType ?? olds?.perimeterType ?? output?.perimeterType,
      );
      const typeChanged = previousType !== nextType;
      return replaceOnIdentity(idChanged || policyChanged || typeChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const servicePerimeterId = yield* toAcmId(
        id,
        olds?.servicePerimeterId,
        output?.servicePerimeterId,
      );
      const policy = olds?.policy ?? output?.policy;
      if (policy === undefined) return undefined;
      const name =
        output?.name ??
        resourceNameOf(policy, "servicePerimeters", servicePerimeterId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.description ?? existing.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const policies = yield* listOwnedPolicies();
        const perimeters = yield* Effect.forEach(
          policies,
          (policy) =>
            policy.name
              ? listPerimeters(policy.name)
              : Effect.succeed([] as acm.ServicePerimeter[]),
          { concurrency: 4 },
        );
        return perimeters
          .flat()
          .filter(
            (perimeter) =>
              parseOwnership(perimeter.description ?? perimeter.title).labels[
                "alchemy-id"
              ],
          )
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const policy = policyNameOf(news.policy);
      const servicePerimeterId = yield* toAcmId(
        id,
        news.servicePerimeterId,
        output?.servicePerimeterId,
      );
      const name = resourceNameOf(
        policy,
        "servicePerimeters",
        servicePerimeterId,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredTitle = encodeOwnershipLine(
        ownership,
        news.title ?? servicePerimeterId,
        MAX_TITLE_LENGTH,
      );
      const desiredDescription = encodeOwnership(
        ownership,
        news.description,
        MAX_DESCRIPTION_LENGTH,
      );
      const desiredType = typeOf(news.perimeterType);
      const desiredDryRun = news.useExplicitDryRunSpec === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* acm
          .createAccessPoliciesServicePerimeters({
            parent: policy,
            body: {
              name,
              title: desiredTitle,
              description: desiredDescription,
              perimeterType: desiredType,
              useExplicitDryRunSpec: desiredDryRun ? true : undefined,
              status: news.status,
              spec: news.spec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new AccessPoliciesServicePerimeterNotResolved({ name });
      }

      const titleChanged = (current.title ?? "") !== desiredTitle;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const dryRunChanged =
        (current.useExplicitDryRunSpec === true) !== desiredDryRun;
      const statusChanged =
        news.status !== undefined && !jsonEqual(current.status, news.status);
      const specChanged =
        news.spec !== undefined && !jsonEqual(current.spec, news.spec);

      const updateMask = [
        titleChanged ? "title" : undefined,
        descriptionChanged ? "description" : undefined,
        dryRunChanged ? "use_explicit_dry_run_spec" : undefined,
        statusChanged ? "status" : undefined,
        specChanged ? "spec" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        const operation = yield* acm.patchAccessPoliciesServicePerimeters({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name ?? name,
            title: desiredTitle,
            description: desiredDescription,
            useExplicitDryRunSpec: desiredDryRun,
            status: news.status,
            spec: news.spec,
            etag: current.etag,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      if (current === undefined) {
        return yield* new AccessPoliciesServicePerimeterNotResolved({ name });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* acm
        .deleteAccessPoliciesServicePerimeters({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
