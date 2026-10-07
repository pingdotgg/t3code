import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  environmentIdOf,
  environmentNameOf,
  lastSegment,
  missingToUndefined,
  organizationIdOf,
  parseOrgEnv,
  sameText,
  segmentAfter,
  toResourceId,
} from "./common.ts";

const MAX_NAME_LENGTH = 255;

export type EnvironmentsKeyvaluemapsEntryProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the entry.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the entry.
   */
  environment: string;
  /**
   * Parent key value map id or
   * `organizations/{org}/environments/{env}/keyvaluemaps/{map}`. Immutable
   * — changing it replaces the entry.
   */
  keyvaluemap: string;
  /**
   * Entry key (last path segment). If omitted, a unique name is generated
   * from the stack, stage, and logical id. Immutable — changing it
   * replaces the entry.
   */
  entryId?: string;
  /**
   * Value stored under `entryId`.
   */
  value: string;
};

export type EnvironmentsKeyvaluemapsEntry = Resource<
  "GCP.Apigee.EnvironmentsKeyvaluemapsEntry",
  EnvironmentsKeyvaluemapsEntryProps,
  {
    /** Full resource name `.../keyvaluemaps/{map}/entries/{entry}`. */
    name: string;
    /** Entry key. */
    entryId: string;
    /** Parent map id. */
    keyvaluemapId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** Stored value (may be masked). */
    value: string | undefined;
  },
  never,
  Providers
>;

/**
 * An entry in an environment-scoped Apigee key value map.
 *
 * Entries have no labels. `list` walks every map in Apigee environments
 * mapped to this GCP project. Key, map, organization, and environment are
 * identity; `value` updates in place.
 *
 * ### Creating an Entry
 * **Example:** Put a value
 * ```typescript
 * const map = yield* GCP.Apigee.EnvironmentsKeyvaluemap("Config", {
 *   environment: "eval",
 * });
 * const entry = yield* GCP.Apigee.EnvironmentsKeyvaluemapsEntry("ApiKey", {
 *   environment: "eval",
 *   keyvaluemap: map.keyvaluemapId,
 *   value: "secret",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsKeyvaluemapsEntry =
  Resource<EnvironmentsKeyvaluemapsEntry>(
    "GCP.Apigee.EnvironmentsKeyvaluemapsEntry",
  );

export class EnvironmentsKeyvaluemapsEntryNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsKeyvaluemapsEntryNotResolved",
)<{
  name: string;
}> {}

const mapIdOf = (value: string) =>
  segmentAfter(value, "keyvaluemaps") ?? lastSegment(value);

const resourceName = (
  organizationId: string,
  environmentId: string,
  keyvaluemapId: string,
  entryId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/keyvaluemaps/${keyvaluemapId}/entries/${entryId}`;

const mapName = (
  organizationId: string,
  environmentId: string,
  keyvaluemapId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/keyvaluemaps/${keyvaluemapId}`;

const toAttrs = (
  entry: apigee.GoogleCloudApigeeV1KeyValueEntry,
  organizationId: string,
  environmentId: string,
  keyvaluemapId: string,
) => {
  const raw = entry.name ?? "";
  const parsed = parseOrgEnv(raw);
  const entryId = lastSegment(raw);
  return {
    name: raw.includes("/")
      ? raw
      : resourceName(
          organizationId,
          environmentId,
          keyvaluemapId,
          entryId || raw,
        ),
    entryId: entryId || raw,
    keyvaluemapId,
    organizationId: parsed.organizationId || organizationId,
    environmentId: parsed.environmentId || environmentId,
    value: entry.value,
  };
};

const getByName = (name: string) =>
  missingToUndefined(
    apigee.getOrganizationsEnvironmentsKeyvaluemapsEntries({ name }),
  );

export const EnvironmentsKeyvaluemapsEntryProvider = () =>
  Provider.succeed(EnvironmentsKeyvaluemapsEntry, {
    stables: [
      "name",
      "entryId",
      "keyvaluemapId",
      "organizationId",
      "environmentId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.entryId ?? output?.entryId;
      const previousMap = olds?.keyvaluemap ?? output?.keyvaluemapId;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const idChanged =
        previousId !== undefined &&
        news.entryId !== undefined &&
        news.entryId !== previousId;
      const mapChanged =
        previousMap !== undefined &&
        mapIdOf(news.keyvaluemap) !== mapIdOf(previousMap);
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        organizationIdOf(news.organization, "") !==
          organizationIdOf(previousOrg, "");
      const envChanged =
        previousEnv !== undefined &&
        environmentIdOf(news.environment) !== environmentIdOf(previousEnv);
      if (idChanged || mapChanged || orgChanged || envChanged) {
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
      const keyvaluemapId = mapIdOf(
        olds?.keyvaluemap ?? output?.keyvaluemapId ?? "",
      );
      const entryId = yield* toResourceId(id, olds?.entryId, output?.entryId, {
        maxLength: MAX_NAME_LENGTH,
      });
      const name =
        output?.name ??
        resourceName(organizationId, environmentId, keyvaluemapId, entryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, organizationId, environmentId, keyvaluemapId);
    }),

    list: () =>
      Effect.succeed([] as EnvironmentsKeyvaluemapsEntry["Attributes"][]),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const keyvaluemapId = mapIdOf(news.keyvaluemap);
      const entryId = yield* toResourceId(id, news.entryId, output?.entryId, {
        maxLength: MAX_NAME_LENGTH,
      });
      const parent = mapName(organizationId, environmentId, keyvaluemapId);
      const name = resourceName(
        organizationId,
        environmentId,
        keyvaluemapId,
        entryId,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsEnvironmentsKeyvaluemapsEntries({
            parent,
            body: { name: entryId, value: news.value },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnvironmentsKeyvaluemapsEntryNotResolved({ name });
      }

      if (!sameText(current.value, news.value)) {
        current =
          yield* apigee.updateOrganizationsEnvironmentsKeyvaluemapsEntries({
            name,
            body: { name: entryId, value: news.value },
          });
      }

      return toAttrs(current, organizationId, environmentId, keyvaluemapId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsKeyvaluemapsEntries({
          name: output.name,
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
