import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  deployedConfig,
  environmentIdOf,
  environmentNameOf,
  lastSegment,
  listProjectEnvironments,
  missingToUndefined,
  namesFromConfig,
  organizationIdOf,
  parseOrgEnv,
  toResourceId,
} from "./common.ts";

const MAX_NAME_LENGTH = 255;

export type EnvironmentsKeystoreProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the keystore.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the keystore.
   */
  environment: string;
  /**
   * Keystore id (last path segment). If omitted, a unique name is generated
   * from the stack, stage, and logical id. Must match
   * `[\w[:space:].-]{1,255}`. Immutable — changing it replaces the keystore.
   */
  keystoreId?: string;
};

export type EnvironmentsKeystore = Resource<
  "GCP.Apigee.EnvironmentsKeystore",
  EnvironmentsKeystoreProps,
  {
    /** Full resource name `organizations/{org}/environments/{env}/keystores/{keystore}`. */
    name: string;
    /** Keystore id (last path segment). */
    keystoreId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** Alias ids stored in this keystore. */
    aliases: string[];
  },
  never,
  Providers
>;

/**
 * An Apigee environment keystore or truststore for TLS certificates.
 *
 * Keystores have no labels or description, so `list` enumerates every
 * keystore in Apigee environments mapped to this GCP project for
 * `pnpm nuke:gcp`. Name is identity — changing `keystoreId`,
 * `organization`, or `environment` replaces the keystore. Aliases are
 * managed by `EnvironmentsKeystoresAlias`.
 *
 * ### Creating a Keystore
 * **Example:** Generated name
 * ```typescript
 * const keystore = yield* GCP.Apigee.EnvironmentsKeystore("Tls", {
 *   environment: "eval",
 * });
 * ```
 *
 * **Example:** Named keystore
 * ```typescript
 * const keystore = yield* GCP.Apigee.EnvironmentsKeystore("Tls", {
 *   environment: "eval",
 *   keystoreId: "app-tls",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsKeystore = Resource<EnvironmentsKeystore>(
  "GCP.Apigee.EnvironmentsKeystore",
);

export class EnvironmentsKeystoreNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsKeystoreNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  organizationId: string,
  environmentId: string,
  keystoreId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/keystores/${keystoreId}`;

const toAttrs = (
  keystore: apigee.GoogleCloudApigeeV1Keystore,
  organizationId: string,
  environmentId: string,
) => {
  const raw = keystore.name ?? "";
  const parsed = parseOrgEnv(raw);
  const keystoreId = lastSegment(raw);
  return {
    name: raw.includes("/")
      ? raw
      : resourceName(organizationId, environmentId, keystoreId || raw),
    keystoreId: keystoreId || raw,
    organizationId: parsed.organizationId || organizationId,
    environmentId: parsed.environmentId || environmentId,
    aliases: keystore.aliases ?? [],
  };
};

const getByName = (name: string) =>
  missingToUndefined(apigee.getOrganizationsEnvironmentsKeystores({ name }));

const listIds = (parent: string) =>
  deployedConfig(parent).pipe(
    Effect.map((config) => namesFromConfig(config?.keystores)),
  );

export const EnvironmentsKeystoreProvider = () =>
  Provider.succeed(EnvironmentsKeystore, {
    stables: ["name", "keystoreId", "organizationId", "environmentId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.keystoreId ?? output?.keystoreId;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const idChanged =
        previousId !== undefined &&
        news.keystoreId !== undefined &&
        news.keystoreId !== previousId;
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
      const keystoreId = yield* toResourceId(
        id,
        olds?.keystoreId,
        output?.keystoreId,
        { maxLength: MAX_NAME_LENGTH },
      );
      const name =
        output?.name ?? resourceName(organizationId, environmentId, keystoreId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, organizationId, environmentId);
    }),

    list: () =>
      Effect.gen(function* () {
        const environments = yield* listProjectEnvironments();
        const found: EnvironmentsKeystore["Attributes"][] = [];
        for (const item of environments) {
          const ids = yield* listIds(item.parent);
          for (const raw of ids) {
            const name = raw.includes("/")
              ? raw
              : resourceName(item.organizationId, item.environmentId, raw);
            const keystore = yield* getByName(name);
            if (keystore === undefined) {
              found.push(
                toAttrs({ name }, item.organizationId, item.environmentId),
              );
              continue;
            }
            found.push(
              toAttrs(keystore, item.organizationId, item.environmentId),
            );
          }
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const keystoreId = yield* toResourceId(
        id,
        news.keystoreId,
        output?.keystoreId,
        { maxLength: MAX_NAME_LENGTH },
      );
      const parent = environmentNameOf(organizationId, environmentId);
      const name = resourceName(organizationId, environmentId, keystoreId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsEnvironmentsKeystores({
            parent,
            name: keystoreId,
            body: { name: keystoreId },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnvironmentsKeystoreNotResolved({ name });
      }

      return toAttrs(current, organizationId, environmentId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsKeystores({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
