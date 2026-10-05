import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
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

const MAX_NAME_LENGTH = 255;

export type TargetServerTlsCommonName = {
  /** TLS common name to match. */
  value?: string;
  /** Match the cert as a wildcard. */
  wildcardMatch?: boolean;
};

export type TargetServerTlsInfo = {
  /** Enable TLS. */
  enabled?: boolean;
  /** Ignore TLS certificate errors. */
  ignoreValidationErrors?: boolean;
  /** Enable two-way TLS. */
  clientAuthEnabled?: boolean;
  /** Truststore resource id. */
  trustStore?: string;
  /** Key alias when client auth is enabled. */
  keyAlias?: string;
  /** Keystore resource id when client auth is enabled. */
  keyStore?: string;
  /** TLS common name. */
  commonName?: TargetServerTlsCommonName;
  /** TLS protocol versions. */
  protocols?: string[];
  /** Cipher suites. */
  ciphers?: string[];
  /** Strictly enforce TLS. */
  enforce?: boolean;
};

export type EnvironmentsTargetserverProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the server.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the server.
   */
  environment: string;
  /**
   * Target server id. If omitted, a unique name is generated from the
   * stack, stage, and logical id. Immutable — changing it replaces the
   * server.
   */
  targetserverId?: string;
  /**
   * Hostname this target connects to (RFC-1123).
   */
  host: string;
  /**
   * Port on `host`. Must be between 1 and 65535.
   */
  port: number;
  /**
   * Protocol. Immutable — changing it replaces the server.
   */
  protocol?: apigee.GoogleCloudApigeeV1TargetServerProtocolEnum | (string & {});
  /**
   * Human-readable description. Alchemy stamps ownership into a
   * `[alchemy …]` prefix because target servers have no labels field.
   */
  description?: string;
  /**
   * Whether the target is in rotation.
   * @default true
   */
  isEnabled?: boolean;
  /**
   * TLS configuration (`sSLInfo` on the wire).
   */
  sSLInfo?: TargetServerTlsInfo;
};

export type EnvironmentsTargetserver = Resource<
  "GCP.Apigee.EnvironmentsTargetserver",
  EnvironmentsTargetserverProps,
  {
    /** Full resource name `organizations/{org}/environments/{env}/targetservers/{id}`. */
    name: string;
    /** Target server id. */
    targetserverId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** Hostname. */
    host: string;
    /** Port. */
    port: number;
    /** Protocol. */
    protocol: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the target is enabled. */
    isEnabled: boolean;
    /** TLS configuration. */
    sSLInfo: TargetServerTlsInfo | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee environment TargetServer — a named backend host:port used by
 * proxy TargetEndpoints.
 *
 * Target servers have no labels, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Name and protocol are identity; host,
 * port, enabled flag, description, and TLS settings update in place.
 *
 * ### Creating a Target Server
 * **Example:** HTTP backend
 * ```typescript
 * const backend = yield* GCP.Apigee.EnvironmentsTargetserver("Api", {
 *   environment: "eval",
 *   host: "backend.example.com",
 *   port: 443,
 *   protocol: "HTTP",
 *   sSLInfo: { enabled: true },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsTargetserver = Resource<EnvironmentsTargetserver>(
  "GCP.Apigee.EnvironmentsTargetserver",
);

export class EnvironmentsTargetserverNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsTargetserverNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  organizationId: string,
  environmentId: string,
  targetserverId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/targetservers/${targetserverId}`;

const tlsOf = (
  info: apigee.GoogleCloudApigeeV1TlsInfo | undefined,
): TargetServerTlsInfo | undefined => {
  if (info === undefined) return undefined;
  return {
    enabled: info.enabled,
    ignoreValidationErrors: info.ignoreValidationErrors,
    clientAuthEnabled: info.clientAuthEnabled,
    trustStore: info.trustStore,
    keyAlias: info.keyAlias,
    keyStore: info.keyStore,
    commonName: info.commonName
      ? {
          value: info.commonName.value,
          wildcardMatch: info.commonName.wildcardMatch,
        }
      : undefined,
    protocols: info.protocols,
    ciphers: info.ciphers,
    enforce: info.enforce,
  };
};

const toAttrs = (
  server: apigee.GoogleCloudApigeeV1TargetServer,
  organizationId: string,
  environmentId: string,
) => {
  const raw = server.name ?? "";
  const parsed = parseOrgEnv(raw);
  const targetserverId = lastSegment(raw);
  const description = parseDescription(server.description);
  return {
    name: raw.includes("/")
      ? raw
      : resourceName(organizationId, environmentId, targetserverId || raw),
    targetserverId: targetserverId || raw,
    organizationId: parsed.organizationId || organizationId,
    environmentId: parsed.environmentId || environmentId,
    host: server.host ?? "",
    port: server.port ?? 0,
    protocol: server.protocol,
    description: description.description,
    isEnabled: server.isEnabled !== false,
    sSLInfo: tlsOf(server.sSLInfo),
  };
};

const getByName = (name: string) =>
  missingToUndefined(
    apigee.getOrganizationsEnvironmentsTargetservers({ name }),
  );

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

export const EnvironmentsTargetserverProvider = () =>
  Provider.succeed(EnvironmentsTargetserver, {
    stables: ["name", "targetserverId", "organizationId", "environmentId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.targetserverId ?? output?.targetserverId;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const previousProtocol = olds?.protocol ?? output?.protocol;
      const idChanged =
        previousId !== undefined &&
        news.targetserverId !== undefined &&
        news.targetserverId !== previousId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        organizationIdOf(news.organization, "") !==
          organizationIdOf(previousOrg, "");
      const envChanged =
        previousEnv !== undefined &&
        environmentIdOf(news.environment) !== environmentIdOf(previousEnv);
      const protocolChanged =
        previousProtocol !== undefined &&
        news.protocol !== undefined &&
        news.protocol !== previousProtocol;
      if (idChanged || orgChanged || envChanged || protocolChanged) {
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
      const targetserverId = yield* toResourceId(
        id,
        olds?.targetserverId,
        output?.targetserverId,
        { maxLength: MAX_NAME_LENGTH },
      );
      const name =
        output?.name ??
        resourceName(organizationId, environmentId, targetserverId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organizationId, environmentId);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedById(id, tagRecord(labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const environments = yield* listProjectEnvironments();
        const found: EnvironmentsTargetserver["Attributes"][] = [];
        for (const item of environments) {
          const ids = namesFromConfig(
            (yield* deployedConfig(item.parent))?.targets,
          );
          for (const raw of ids) {
            const name = raw.includes("/")
              ? raw
              : resourceName(item.organizationId, item.environmentId, raw);
            const server = yield* getByName(name);
            if (server === undefined) continue;
            if (!hasOwnershipMarker(server.description)) continue;
            found.push(
              toAttrs(server, item.organizationId, item.environmentId),
            );
          }
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const targetserverId = yield* toResourceId(
        id,
        news.targetserverId,
        output?.targetserverId,
        { maxLength: MAX_NAME_LENGTH },
      );
      const parent = environmentNameOf(organizationId, environmentId);
      const name = resourceName(organizationId, environmentId, targetserverId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredEnabled = news.isEnabled !== false;
      const body: apigee.GoogleCloudApigeeV1TargetServer = {
        name: targetserverId,
        host: news.host,
        port: news.port,
        protocol: news.protocol,
        description: desiredDescription,
        isEnabled: desiredEnabled,
        sSLInfo: news.sSLInfo,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsEnvironmentsTargetservers({
            parent,
            name: targetserverId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnvironmentsTargetserverNotResolved({ name });
      }

      const hostChanged = !sameText(current.host, news.host);
      const portChanged = (current.port ?? 0) !== news.port;
      const descriptionChanged = !sameText(
        current.description,
        desiredDescription,
      );
      const enabledChanged = (current.isEnabled !== false) !== desiredEnabled;
      const tlsChanged =
        jsonOf(tlsOf(current.sSLInfo)) !== jsonOf(news.sSLInfo);

      if (
        hostChanged ||
        portChanged ||
        descriptionChanged ||
        enabledChanged ||
        tlsChanged
      ) {
        current = yield* apigee.updateOrganizationsEnvironmentsTargetservers({
          name,
          body,
        });
      }

      return toAttrs(current, organizationId, environmentId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsTargetservers({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
