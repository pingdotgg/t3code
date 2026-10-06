import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  findSfdcInstanceByDescription,
  listSfdcInstances,
} from "./internal.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  isDeleted,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  withProjectId,
  replaceOnIdentity,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type SfdcInstanceProps = {
  /**
   * Instance id (the `{sfdcInstance}` segment of
   * `projects/{project}/locations/{location}/sfdcInstances/{sfdcInstance}`).
   * Server-assigned on create when omitted. Immutable — changing it
   * replaces the instance.
   */
  sfdcInstanceId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * instance. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * User-selected unique alias for the instance.
   */
  displayName?: string;
  /**
   * Human-readable description. SFDC instances have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  description?: string;
  /**
   * Salesforce org id (`00D…`). Stored on the instance; Application
   * Integration uses it when opening channels.
   */
  sfdcOrgId?: string;
  /**
   * AuthConfig resource names that can be tried to open a channel to
   * Salesforce.
   */
  authConfigId?: string[];
  /**
   * URL used for API calls after authentication (login authority lives
   * on the referenced AuthConfig).
   */
  serviceAuthority?: string;
};

export type SfdcInstance = Resource<
  "GCP.Integrations.SfdcInstance",
  SfdcInstanceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/sfdcInstances/{id}`. */
    name: string;
    /** Instance id (last path segment). */
    sfdcInstanceId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-selected alias. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Salesforce org id. */
    sfdcOrgId: string | undefined;
    /** AuthConfig resource names. */
    authConfigId: string[];
    /** Post-auth API authority URL. */
    serviceAuthority: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Salesforce instance record in Application Integration. Holds org
 * identity and the AuthConfigs used to open SFDC channels.
 *
 * Instances have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Location and id are identity — changing
 * them replaces the instance. Display name, description, org id, auth
 * configs, and service authority update in place.
 *
 * ### Creating an SFDC Instance
 * **Example:** Org alias in us-central1
 * ```typescript
 * const instance = yield* GCP.Integrations.SfdcInstance("Salesforce", {
 *   displayName: "prod-org",
 *   description: "production salesforce",
 *   sfdcOrgId: "00Dxx0000000001",
 * });
 * ```
 *
 * ### Updating an SFDC Instance
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Change alias and org id
 * ```typescript
 * const instance = yield* GCP.Integrations.SfdcInstance("Salesforce", {
 *   displayName: "prod-org-v2",
 *   description: "production salesforce v2",
 *   sfdcOrgId: "00Dxx0000000002",
 * });
 * ```
 *
 * @resource
 * @category Integrations
 */
export const SfdcInstance = Resource<SfdcInstance>(
  "GCP.Integrations.SfdcInstance",
);

export class SfdcInstanceNotResolved extends Data.TaggedError(
  "GCP.Integrations.SfdcInstanceNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  sfdcInstanceId: string,
) => `${locationParent(project, location)}/sfdcInstances/${sfdcInstanceId}`;

const toAttrs = (
  instance: integrations.GoogleCloudIntegrationsV1alphaSfdcInstance,
  project: string,
  region: string,
) => {
  const name = withProjectId(instance.name ?? "", project);
  return {
    name,
    sfdcInstanceId: lastSegment(name),
    location: locationOf(name, region),
    project,
    displayName: instance.displayName,
    description: parseOwnership(instance.description).text,
    sfdcOrgId: instance.sfdcOrgId,
    authConfigId: [...(instance.authConfigId ?? [])],
    serviceAuthority: instance.serviceAuthority,
    createTime: instance.createTime,
    updateTime: instance.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : integrations.getProjectsLocationsSfdcInstances({ name }).pipe(
        Effect.map((instance) => (isDeleted(instance) ? undefined : instance)),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );

export const SfdcInstanceProvider = () =>
  Provider.succeed(SfdcInstance, {
    stables: ["name", "sfdcInstanceId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.sfdcInstanceId ?? output?.sfdcInstanceId;
      const idChanged =
        previousId !== undefined &&
        news.sfdcInstanceId !== undefined &&
        news.sfdcInstanceId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(news.location, env.region) !==
          normalizeLocation(previousLocation, env.region);
      return replaceOnIdentity(idChanged || locationChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sfdcInstanceId = yield* toResourceId(
        id,
        olds?.sfdcInstanceId,
        output?.sfdcInstanceId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, sfdcInstanceId);
      let existing = yield* getByName(name);
      if (existing === undefined && output?.name === undefined) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findSfdcInstanceByDescription(
          locationParent(env.project, location),
          encodeOwnership(ownership, olds?.description),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listSfdcInstances(
          locationParent(env.project, env.region),
        );
        return items
          .filter((instance) => hasOwnershipMarker(instance.description))
          .map((instance) => toAttrs(instance, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const sfdcInstanceId = yield* toResourceId(
        id,
        news.sfdcInstanceId,
        output?.sfdcInstanceId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, sfdcInstanceId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? sfdcInstanceId;
      const authConfigId = news.authConfigId;
      const body: integrations.GoogleCloudIntegrationsV1alphaSfdcInstance = {
        displayName,
        description,
        sfdcOrgId: news.sfdcOrgId,
        authConfigId,
        serviceAuthority: news.serviceAuthority,
      };

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findSfdcInstanceByDescription(parent, description);
      }

      if (current === undefined) {
        const created = yield* integrations
          .createProjectsLocationsSfdcInstances({
            parent,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findSfdcInstanceByDescription(parent, description),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SfdcInstanceNotResolved({ name });
      }

      const currentName = withProjectId(current.name ?? name, env.project);
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const orgChanged = !sameText(current.sfdcOrgId, news.sfdcOrgId);
      const authChanged = !sameStringList(current.authConfigId, authConfigId);
      const authorityChanged = !sameText(
        current.serviceAuthority,
        news.serviceAuthority,
      );

      if (
        displayChanged ||
        descriptionChanged ||
        orgChanged ||
        authChanged ||
        authorityChanged
      ) {
        current = yield* integrations.patchProjectsLocationsSfdcInstances({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            descriptionChanged ? "description" : undefined,
            orgChanged ? "sfdcOrgId" : undefined,
            authChanged ? "authConfigId" : undefined,
            authorityChanged ? "serviceAuthority" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* integrations
        .deleteProjectsLocationsSfdcInstances({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) => JSON.stringify([...(left ?? [])]) === JSON.stringify([...(right ?? [])]);
