import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  deployedConfig,
  encodeDescription,
  environmentIdOf,
  environmentNameOf,
  hasOwnershipMarker,
  lastSegment,
  listProjectEnvironments,
  missingToUndefined,
  namesFromConfig,
  organizationIdOf,
  ownedById,
  parseDescription,
  parseOrgEnv,
  sameText,
  toResourceId,
} from "./common.ts";
import { createInternalLabels } from "../Labels.ts";

const MAX_NAME_LENGTH = 255;
const DEFAULT_RESOURCE_TYPE = "KeyStore";

export type EnvironmentsReferenceProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the reference.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the reference.
   */
  environment: string;
  /**
   * Reference id. If omitted, a unique name is generated from the stack,
   * stage, and logical id. Immutable — changing it replaces the reference.
   */
  referenceId?: string;
  /**
   * Id of the keystore or truststore this reference points at. Must exist
   * in the same environment.
   */
  refers: string;
  /**
   * Resource type referred to. Valid values are `KeyStore` or `TrustStore`.
   * @default "KeyStore"
   */
  resourceType?: string;
  /**
   * Human-readable description. Alchemy stamps ownership into a
   * `[alchemy …]` prefix because references have no labels field.
   */
  description?: string;
};

export type EnvironmentsReference = Resource<
  "GCP.Apigee.EnvironmentsReference",
  EnvironmentsReferenceProps,
  {
    /** Full resource name `organizations/{org}/environments/{env}/references/{ref}`. */
    name: string;
    /** Reference id. */
    referenceId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** Id of the referred keystore or truststore. */
    refers: string;
    /** Resource type (`KeyStore` or `TrustStore`). */
    resourceType: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee environment reference to a keystore or truststore.
 *
 * References have no labels, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Name is identity; `refers`,
 * `resourceType`, and description update in place.
 *
 * ### Creating a Reference
 * **Example:** Point at a keystore
 * ```typescript
 * const keystore = yield* GCP.Apigee.EnvironmentsKeystore("Tls", {
 *   environment: "eval",
 * });
 * const reference = yield* GCP.Apigee.EnvironmentsReference("TlsRef", {
 *   environment: "eval",
 *   refers: keystore.keystoreId,
 *   resourceType: "KeyStore",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsReference = Resource<EnvironmentsReference>(
  "GCP.Apigee.EnvironmentsReference",
);

export class EnvironmentsReferenceNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsReferenceNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  organizationId: string,
  environmentId: string,
  referenceId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/references/${referenceId}`;

const toAttrs = (
  reference: apigee.GoogleCloudApigeeV1Reference,
  organizationId: string,
  environmentId: string,
) => {
  const raw = reference.name ?? "";
  const parsed = parseOrgEnv(raw);
  const referenceId = lastSegment(raw);
  const description = parseDescription(reference.description);
  return {
    name: raw.includes("/")
      ? raw
      : resourceName(organizationId, environmentId, referenceId || raw),
    referenceId: referenceId || raw,
    organizationId: parsed.organizationId || organizationId,
    environmentId: parsed.environmentId || environmentId,
    refers: reference.refers ?? "",
    resourceType: reference.resourceType,
    description: description.description,
  };
};

const getByName = (name: string) =>
  missingToUndefined(apigee.getOrganizationsEnvironmentsReferences({ name }));

export const EnvironmentsReferenceProvider = () =>
  Provider.succeed(EnvironmentsReference, {
    stables: ["name", "referenceId", "organizationId", "environmentId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.referenceId ?? output?.referenceId;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const idChanged =
        previousId !== undefined &&
        news.referenceId !== undefined &&
        news.referenceId !== previousId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        organizationIdOf(news.organization, "") !==
          organizationIdOf(previousOrg, "");
      const envChanged =
        previousEnv !== undefined &&
        environmentIdOf(news.environment) !== environmentIdOf(previousEnv);
      if (idChanged || orgChanged || envChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(
        olds?.organization ?? output?.organizationId,
        project,
      );
      const environmentId = environmentIdOf(
        olds?.environment ?? output?.environmentId ?? "",
      );
      const referenceId = yield* toResourceId(
        id,
        olds?.referenceId,
        output?.referenceId,
        { maxLength: MAX_NAME_LENGTH },
      );
      const name =
        output?.name ??
        resourceName(organizationId, environmentId, referenceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organizationId, environmentId);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedById(id, tagRecord(labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const environments = yield* listProjectEnvironments();
        const found: EnvironmentsReference["Attributes"][] = [];
        for (const item of environments) {
          const ids = namesFromConfig(
            (yield* deployedConfig(item.parent))?.resourceReferences,
          );
          for (const raw of ids) {
            const name = raw.includes("/")
              ? raw
              : resourceName(item.organizationId, item.environmentId, raw);
            const reference = yield* getByName(name);
            if (reference === undefined) continue;
            if (!hasOwnershipMarker(reference.description)) continue;
            found.push(
              toAttrs(reference, item.organizationId, item.environmentId),
            );
          }
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const referenceId = yield* toResourceId(
        id,
        news.referenceId,
        output?.referenceId,
        { maxLength: MAX_NAME_LENGTH },
      );
      const parent = environmentNameOf(organizationId, environmentId);
      const name = resourceName(organizationId, environmentId, referenceId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredType = news.resourceType ?? DEFAULT_RESOURCE_TYPE;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsEnvironmentsReferences({
            parent,
            body: {
              name: referenceId,
              refers: news.refers,
              resourceType: desiredType,
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnvironmentsReferenceNotResolved({ name });
      }

      if (
        !sameText(current.refers, news.refers) ||
        !sameText(current.resourceType, desiredType) ||
        !sameText(current.description, desiredDescription)
      ) {
        current = yield* apigee.updateOrganizationsEnvironmentsReferences({
          name,
          body: {
            name: referenceId,
            refers: news.refers,
            resourceType: desiredType,
            description: desiredDescription,
          },
        });
      }

      return toAttrs(current, organizationId, environmentId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsReferences({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
