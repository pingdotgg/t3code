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
  organizationIdOf,
  parseOrgEnv,
  segmentAfter,
  stripRevision,
  toResourceId,
} from "./common.ts";

const MAX_NAME_LENGTH = 255;
const DEFAULT_FORMAT = "selfsignedcert";

export type AliasSubject = {
  /** X.509 common name. */
  commonName?: string;
  /** ISO country code. */
  countryCode?: string;
  /** Email address. */
  email?: string;
  /** Locality. */
  locality?: string;
  /** Organization. */
  org?: string;
  /** Organizational unit. */
  orgUnit?: string;
  /** State or province. */
  state?: string;
};

export type EnvironmentsKeystoresAliasProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the alias.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the alias.
   */
  environment: string;
  /**
   * Parent keystore id or
   * `organizations/{org}/environments/{env}/keystores/{keystore}`.
   * Immutable — changing it replaces the alias.
   */
  keystore: string;
  /**
   * Alias id. If omitted, a unique name is generated from the stack,
   * stage, and logical id. Must match `[\w\s-.]{1,255}`. Immutable —
   * changing it replaces the alias.
   */
  aliasId?: string;
  /**
   * Upload format: `selfsignedcert`, `keycertfile`, or `pkcs12`.
   * @default "selfsignedcert"
   */
  format?: "selfsignedcert" | "keycertfile" | "pkcs12" | (string & {});
  /**
   * Skip newline validation between certificates in a chain.
   * @default false
   */
  ignoreNewlineValidation?: boolean;
  /**
   * Skip certificate expiry validation.
   * @default false
   */
  ignoreExpiryValidation?: boolean;
  /**
   * Private key password when `format` is `keycertfile` or `pkcs12`.
   */
  password?: string;
  /**
   * RSA key size for `selfsignedcert` (`1024`, `2048`, `4096`).
   * @default "2048"
   */
  keySize?: string;
  /**
   * Signature algorithm for `selfsignedcert`.
   * @default "SHA256withRSA"
   */
  sigAlg?: string;
  /**
   * Certificate validity in days for `selfsignedcert`.
   * @default 365
   */
  certValidityInDays?: number;
  /**
   * X.509 subject for `selfsignedcert`.
   */
  subject?: AliasSubject;
  /**
   * Subject alternative names for `selfsignedcert`.
   */
  subjectAlternativeNames?: string[];
  /**
   * PEM certificate (and optional chain) when `format` is `keycertfile`.
   */
  certPem?: string;
  /**
   * PEM private key when `format` is `keycertfile`.
   */
  keyPem?: string;
};

export type EnvironmentsKeystoresAlias = Resource<
  "GCP.Apigee.EnvironmentsKeystoresAlias",
  EnvironmentsKeystoresAliasProps,
  {
    /** Full resource name `organizations/{org}/environments/{env}/keystores/{keystore}/aliases/{alias}`. */
    name: string;
    /** Alias id. */
    aliasId: string;
    /** Parent keystore id. */
    keystoreId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** Alias type (`CERT` or `KEY_CERT`). */
    type: string | undefined;
    /** Subject of the leaf certificate, if returned. */
    subject: string | undefined;
    /** Certificate expiry in milliseconds since epoch, if returned. */
    expiryDate: string | undefined;
  },
  never,
  Providers
>;

/**
 * An alias in an Apigee environment keystore — a certificate or
 * key/certificate pair used for TLS.
 *
 * Aliases have no labels or description, so `list` enumerates every alias
 * in keystores of Apigee environments mapped to this GCP project.
 * Name, keystore, organization, and environment are identity. Certificate
 * material can be rotated with an in-place update.
 *
 * ### Creating a Self-Signed Alias
 * **Example:** Generated self-signed certificate
 * ```typescript
 * const keystore = yield* GCP.Apigee.EnvironmentsKeystore("Tls", {
 *   environment: "eval",
 * });
 * const alias = yield* GCP.Apigee.EnvironmentsKeystoresAlias("Server", {
 *   environment: "eval",
 *   keystore: keystore.keystoreId,
 *   subject: { commonName: "api.example.com" },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsKeystoresAlias = Resource<EnvironmentsKeystoresAlias>(
  "GCP.Apigee.EnvironmentsKeystoresAlias",
);

export class EnvironmentsKeystoresAliasNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsKeystoresAliasNotResolved",
)<{
  name: string;
}> {}

const keystoreIdOf = (value: string) =>
  segmentAfter(value, "keystores") ?? lastSegment(value);

const resourceName = (
  organizationId: string,
  environmentId: string,
  keystoreId: string,
  aliasId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/keystores/${keystoreId}/aliases/${aliasId}`;

const keystoreName = (
  organizationId: string,
  environmentId: string,
  keystoreId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/keystores/${keystoreId}`;

const toAttrs = (
  alias: apigee.GoogleCloudApigeeV1Alias,
  organizationId: string,
  environmentId: string,
  keystoreId: string,
) => {
  const aliasId = alias.alias ?? lastSegment(alias.alias ?? "");
  const cert = alias.certsInfo?.certInfo?.[0];
  const name = resourceName(
    organizationId,
    environmentId,
    keystoreId,
    aliasId || "alias",
  );
  return {
    name,
    aliasId: aliasId || lastSegment(name),
    keystoreId,
    organizationId,
    environmentId,
    type: alias.type,
    subject: cert?.subject,
    expiryDate: cert?.expiryDate,
  };
};

const getByName = (name: string) =>
  missingToUndefined(
    apigee.getOrganizationsEnvironmentsKeystoresAliases({ name }),
  );

const selfSignedBody = (
  aliasId: string,
  news: EnvironmentsKeystoresAliasProps,
): apigee.GoogleApiHttpBody =>
  ({
    alias: aliasId,
    keySize: news.keySize ?? "2048",
    sigAlg: news.sigAlg ?? "SHA256withRSA",
    certValidityInDays: news.certValidityInDays ?? 365,
    subject: {
      commonName:
        news.subject?.commonName ??
        news.subjectAlternativeNames?.[0] ??
        aliasId,
      countryCode: news.subject?.countryCode,
      email: news.subject?.email,
      locality: news.subject?.locality,
      org: news.subject?.org,
      orgUnit: news.subject?.orgUnit,
      state: news.subject?.state,
    },
    subjectAlternativeNames: news.subjectAlternativeNames,
  }) as apigee.GoogleApiHttpBody;

const keyCertBody = (
  news: EnvironmentsKeystoresAliasProps,
): apigee.GoogleApiHttpBody => ({
  contentType: "application/x-pem-file",
  data: news.certPem,
});

const createBody = (
  aliasId: string,
  news: EnvironmentsKeystoresAliasProps,
): apigee.GoogleApiHttpBody => {
  const format = news.format ?? DEFAULT_FORMAT;
  if (format === "selfsignedcert") return selfSignedBody(aliasId, news);
  if (news.certPem !== undefined) return keyCertBody(news);
  return selfSignedBody(aliasId, news);
};

export const EnvironmentsKeystoresAliasProvider = () =>
  Provider.succeed(EnvironmentsKeystoresAlias, {
    stables: [
      "name",
      "aliasId",
      "keystoreId",
      "organizationId",
      "environmentId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.aliasId ?? output?.aliasId;
      const previousKeystore = olds?.keystore ?? output?.keystoreId;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const idChanged =
        previousId !== undefined &&
        news.aliasId !== undefined &&
        news.aliasId !== previousId;
      const keystoreChanged =
        previousKeystore !== undefined &&
        keystoreIdOf(news.keystore) !== keystoreIdOf(previousKeystore);
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        organizationIdOf(news.organization, "") !==
          organizationIdOf(previousOrg, "");
      const envChanged =
        previousEnv !== undefined &&
        environmentIdOf(news.environment) !== environmentIdOf(previousEnv);
      if (idChanged || keystoreChanged || orgChanged || envChanged) {
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
      const keystoreId = keystoreIdOf(
        olds?.keystore ?? output?.keystoreId ?? "",
      );
      const aliasId = yield* toResourceId(id, olds?.aliasId, output?.aliasId, {
        maxLength: MAX_NAME_LENGTH,
      });
      const name =
        output?.name ??
        resourceName(organizationId, environmentId, keystoreId, aliasId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, organizationId, environmentId, keystoreId);
    }),

    list: () =>
      Effect.gen(function* () {
        const environments = yield* listProjectEnvironments();
        const found: EnvironmentsKeystoresAlias["Attributes"][] = [];
        for (const item of environments) {
          const config = yield* deployedConfig(item.parent);
          for (const keystore of config?.keystores ?? []) {
            const keystoreId = keystoreIdOf(keystore.name ?? "");
            for (const aliasConfig of keystore.aliases ?? []) {
              const aliasId = lastSegment(
                stripRevision(aliasConfig.name ?? ""),
              );
              if (aliasId.length === 0) continue;
              const name = resourceName(
                item.organizationId,
                item.environmentId,
                keystoreId,
                aliasId,
              );
              const alias = yield* getByName(name);
              found.push(
                toAttrs(
                  alias ?? { alias: aliasId },
                  item.organizationId,
                  item.environmentId,
                  keystoreId,
                ),
              );
            }
          }
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const keystoreId = keystoreIdOf(news.keystore);
      const aliasId = yield* toResourceId(id, news.aliasId, output?.aliasId, {
        maxLength: MAX_NAME_LENGTH,
      });
      const parent = keystoreName(organizationId, environmentId, keystoreId);
      const name = resourceName(
        organizationId,
        environmentId,
        keystoreId,
        aliasId,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsEnvironmentsKeystoresAliases({
            parent,
            alias: aliasId,
            format: news.format ?? DEFAULT_FORMAT,
            ignoreNewlineValidation: news.ignoreNewlineValidation,
            ignoreExpiryValidation: news.ignoreExpiryValidation,
            _password: news.password,
            body: createBody(aliasId, news),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      } else if (news.certPem !== undefined) {
        current = yield* apigee.updateOrganizationsEnvironmentsKeystoresAliases(
          {
            name,
            ignoreNewlineValidation: news.ignoreNewlineValidation,
            ignoreExpiryValidation: news.ignoreExpiryValidation ?? true,
            body: keyCertBody(news),
          },
        );
      }

      if (current === undefined) {
        return yield* new EnvironmentsKeystoresAliasNotResolved({ name });
      }

      return toAttrs(current, organizationId, environmentId, keystoreId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsKeystoresAliases({
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
