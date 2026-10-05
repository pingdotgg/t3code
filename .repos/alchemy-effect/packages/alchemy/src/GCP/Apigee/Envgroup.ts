import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  defaultOrgName,
  lastSegment,
  letterPrefixedId,
  orgIdOf,
  orgNameOf,
  sameStringList,
  waitForOperation,
} from "./operations.ts";

export type EnvgroupProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the group.
   */
  organization?: string;
  /**
   * Environment group id (the `{envgroup}` segment of
   * `organizations/{org}/envgroups/{envgroup}`). If omitted, a unique
   * name is generated. Immutable — changing it replaces the group.
   */
  envgroupId?: string;
  /**
   * Host names for this environment group.
   */
  hostnames: string[];
};

export type Envgroup = Resource<
  "GCP.Apigee.Envgroup",
  EnvgroupProps,
  {
    /** Full resource name `organizations/{org}/envgroups/{envgroup}`. */
    name: string;
    /** Environment group id (last path segment). */
    envgroupId: string;
    /** Apigee organization id. */
    organization: string;
    /** Host names routed to this group. */
    hostnames: string[];
    /** Server-reported state (`CREATING`, `ACTIVE`, …). */
    state: string | undefined;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee environment group that maps hostnames to one or more
 * environments.
 *
 * The API has no labels or description, so Alchemy identifies its groups
 * by the generated `envgroupId`: `read` reports a group with an explicit
 * `envgroupId` as unowned (adopt it with `--adopt`), and nuke cannot
 * discover groups. Name is identity — changing `envgroupId` replaces the
 * group. Hostnames update in place.
 *
 * ### Creating an Environment Group
 * **Example:** Group with a hostname
 * ```typescript
 * const group = yield* GCP.Apigee.Envgroup("Api", {
 *   hostnames: ["api.example.com"],
 * });
 * ```
 *
 * **Example:** Named group
 * ```typescript
 * const group = yield* GCP.Apigee.Envgroup("Api", {
 *   envgroupId: "prod-group",
 *   hostnames: ["api.example.com", "api.example.net"],
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Envgroup = Resource<Envgroup>("GCP.Apigee.Envgroup");

export class EnvgroupNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvgroupNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, envgroupId: string) =>
  `${orgNameOf(organization)}/envgroups/${envgroupId}`;

const toAttrs = (
  group: apigee.GoogleCloudApigeeV1EnvironmentGroup,
  organization: string,
) => {
  const name = group.name ?? "";
  return {
    name,
    envgroupId: lastSegment(name),
    organization: orgIdOf(organization),
    hostnames: [...(group.hostnames ?? [])],
    state: group.state,
    createdAt: group.createdAt,
    lastModifiedAt: group.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsEnvgroups({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const EnvgroupProvider = () =>
  Provider.succeed(Envgroup, {
    stables: ["name", "envgroupId", "organization", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.envgroupId ?? output?.envgroupId;
      const previousOrg = olds?.organization ?? output?.organization;
      const idChanged =
        previousId !== undefined &&
        news.envgroupId !== undefined &&
        news.envgroupId !== previousId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      if (idChanged || orgChanged) {
        return {
          action: "replace" as const,
          deleteFirst: idChanged && !orgChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(
        env.project,
        olds?.organization ?? output?.organization,
      );
      const envgroupId = yield* letterPrefixedId(
        id,
        olds?.envgroupId,
        output?.envgroupId,
        63,
      );
      const name = output?.name ?? resourceName(organization, envgroupId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      const generated = yield* letterPrefixedId(id, undefined, undefined, 63);
      return attrs.envgroupId === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(env.project, news.organization);
      const envgroupId = yield* letterPrefixedId(
        id,
        news.envgroupId,
        output?.envgroupId,
        63,
      );
      const name = resourceName(organization, envgroupId);
      const desiredHostnames = news.hostnames;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const operation = yield* apigee
          .createOrganizationsEnvgroups({
            parent: organization,
            name: envgroupId,
            body: {
              name: envgroupId,
              hostnames: desiredHostnames,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          yield* waitForOperation(operation);
        }
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new EnvgroupNotResolved({ name });
      }

      if (!sameStringList(current.hostnames, desiredHostnames)) {
        const operation = yield* apigee.patchOrganizationsEnvgroups({
          name,
          updateMask: "hostnames",
          body: { hostnames: desiredHostnames },
        });
        yield* waitForOperation(operation);
        current = (yield* getByName(name)) ?? current;
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigee
        .deleteOrganizationsEnvgroups({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
