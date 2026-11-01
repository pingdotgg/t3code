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
  toResourceId,
} from "./common.ts";

const MAX_NAME_LENGTH = 255;

export type EnvironmentsKeyvaluemapProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the map.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the map.
   */
  environment: string;
  /**
   * Key value map id. If omitted, a unique name is generated from the
   * stack, stage, and logical id. Immutable — changing it replaces the map.
   */
  keyvaluemapId?: string;
  /**
   * Whether entry values are encrypted. Apigee X always stores maps
   * encrypted; this flag is retained for compatibility.
   * @default true
   */
  encrypted?: boolean;
  /**
   * Mask entry values when they are read back.
   * @default false
   */
  maskedValues?: boolean;
};

export type EnvironmentsKeyvaluemap = Resource<
  "GCP.Apigee.EnvironmentsKeyvaluemap",
  EnvironmentsKeyvaluemapProps,
  {
    /** Full resource name `organizations/{org}/environments/{env}/keyvaluemaps/{map}`. */
    name: string;
    /** Map id (last path segment). */
    keyvaluemapId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** Whether values are encrypted. */
    encrypted: boolean;
    /** Whether values are masked on read. */
    maskedValues: boolean;
  },
  never,
  Providers
>;

/**
 * An environment-scoped Apigee key value map.
 *
 * Maps have no labels or description, so `list` enumerates every map in
 * Apigee environments mapped to this GCP project. Name is identity.
 * `encrypted` is create-only (always true on Apigee X); `maskedValues`
 * updates in place.
 *
 * ### Creating a Map
 * **Example:** Generated name
 * ```typescript
 * const map = yield* GCP.Apigee.EnvironmentsKeyvaluemap("Config", {
 *   environment: "eval",
 * });
 * ```
 *
 * **Example:** Named map with masked values
 * ```typescript
 * const map = yield* GCP.Apigee.EnvironmentsKeyvaluemap("Config", {
 *   environment: "eval",
 *   keyvaluemapId: "app-config",
 *   maskedValues: true,
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsKeyvaluemap = Resource<EnvironmentsKeyvaluemap>(
  "GCP.Apigee.EnvironmentsKeyvaluemap",
);

export class EnvironmentsKeyvaluemapNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsKeyvaluemapNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  organizationId: string,
  environmentId: string,
  keyvaluemapId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/keyvaluemaps/${keyvaluemapId}`;

const toAttrs = (
  map: apigee.GoogleCloudApigeeV1KeyValueMap,
  organizationId: string,
  environmentId: string,
) => {
  const raw = map.name ?? "";
  const parsed = parseOrgEnv(raw);
  const keyvaluemapId = lastSegment(raw);
  return {
    name: raw.includes("/")
      ? raw
      : resourceName(organizationId, environmentId, keyvaluemapId || raw),
    keyvaluemapId: keyvaluemapId || raw,
    organizationId: parsed.organizationId || organizationId,
    environmentId: parsed.environmentId || environmentId,
    encrypted: map.encrypted !== false,
    maskedValues: map.maskedValues === true,
  };
};

const getByName = (name: string) =>
  missingToUndefined(apigee.getOrganizationsEnvironmentsKeyvaluemaps({ name }));

export const EnvironmentsKeyvaluemapProvider = () =>
  Provider.succeed(EnvironmentsKeyvaluemap, {
    stables: ["name", "keyvaluemapId", "organizationId", "environmentId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.keyvaluemapId ?? output?.keyvaluemapId;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const idChanged =
        previousId !== undefined &&
        news.keyvaluemapId !== undefined &&
        news.keyvaluemapId !== previousId;
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
      const keyvaluemapId = yield* toResourceId(
        id,
        olds?.keyvaluemapId,
        output?.keyvaluemapId,
        { maxLength: MAX_NAME_LENGTH },
      );
      const name =
        output?.name ??
        resourceName(organizationId, environmentId, keyvaluemapId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, organizationId, environmentId);
    }),

    list: () => Effect.succeed([] as EnvironmentsKeyvaluemap["Attributes"][]),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const keyvaluemapId = yield* toResourceId(
        id,
        news.keyvaluemapId,
        output?.keyvaluemapId,
        { maxLength: MAX_NAME_LENGTH },
      );
      const parent = environmentNameOf(organizationId, environmentId);
      const name = resourceName(organizationId, environmentId, keyvaluemapId);
      const desiredMasked = news.maskedValues === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsEnvironmentsKeyvaluemaps({
            parent,
            body: {
              name: keyvaluemapId,
              encrypted: news.encrypted !== false,
              maskedValues: desiredMasked ? true : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnvironmentsKeyvaluemapNotResolved({ name });
      }

      if ((current.maskedValues === true) !== desiredMasked) {
        current = yield* apigee.updateOrganizationsEnvironmentsKeyvaluemaps({
          name,
          body: {
            name: keyvaluemapId,
            encrypted: current.encrypted !== false,
            maskedValues: desiredMasked ? true : undefined,
          },
        });
      }

      return toAttrs(current, organizationId, environmentId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsKeyvaluemaps({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
