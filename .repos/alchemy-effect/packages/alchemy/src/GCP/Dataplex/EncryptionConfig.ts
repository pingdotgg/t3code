import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DataplexNotResolved,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryQuota,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

const DEFAULT_ENCRYPTION_CONFIG_ID = "default";

export type EncryptionConfigFailureDetails =
  dataplex.GoogleCloudDataplexV1EncryptionConfigFailureDetails;

export type EncryptionConfigProps = {
  /**
   * Organization id (the `{organization}` segment of
   * `organizations/{organization}/locations/{location}/encryptionConfigs/{encryptionConfig}`).
   * Immutable — changing it replaces the config.
   */
  organizationId: string;
  /**
   * Region (`us-central1`, …). Global is not supported. Immutable —
   * changing it replaces the config.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * EncryptionConfig id. Currently only `"default"` is supported.
   * Immutable — changing it replaces the config.
   * @default "default"
   */
  encryptionConfigId?: string;
  /**
   * Cloud KMS key for CMEK. Omit to use Google-managed encryption.
   */
  key?: string;
  /**
   * Opt the metastore into CMEK.
   * @default false
   */
  enableMetastoreEncryption?: boolean;
};

export type EncryptionConfig = Resource<
  "GCP.Dataplex.EncryptionConfig",
  EncryptionConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** EncryptionConfig id (last path segment). */
    encryptionConfigId: string;
    /** Organization id. */
    organizationId: string;
    /** Location id. */
    location: string;
    /** CMEK key, if any. */
    key: string | undefined;
    /** Whether metastore CMEK is enabled. */
    enableMetastoreEncryption: boolean;
    /** Encryption state. */
    encryptionState: string | undefined;
    /** Failure details, if any. */
    failureDetails: EncryptionConfigFailureDetails | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex EncryptionConfig that opts an organization location into
 * customer-managed encryption keys (CMEK).
 *
 * EncryptionConfigs have no labels field. Organization, location, and id
 * are immutable (`default` is the only supported id). Key and metastore
 * encryption update in place. `list` returns an empty set because
 * ownership cannot be stamped on this org singleton.
 *
 * ### Creating an EncryptionConfig
 * **Example:** Google-managed encryption at us-central1
 * ```typescript
 * const config = yield* GCP.Dataplex.EncryptionConfig("Default", {
 *   organizationId: "1234567890",
 *   location: "us-central1",
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const EncryptionConfig = Resource<EncryptionConfig>(
  "GCP.Dataplex.EncryptionConfig",
);

const orgParent = (organizationId: string, location: string) =>
  `organizations/${organizationId}/locations/${location}`;

const resourceName = (
  organizationId: string,
  location: string,
  encryptionConfigId: string,
) =>
  `${orgParent(organizationId, location)}/encryptionConfigs/${encryptionConfigId}`;

const toId = (encryptionConfigId: string | undefined, existing?: string) =>
  encryptionConfigId ?? existing ?? DEFAULT_ENCRYPTION_CONFIG_ID;

const toAttrs = (
  config: dataplex.GoogleCloudDataplexV1EncryptionConfig,
  organizationId: string,
) => {
  const name = config.name ?? "";
  const parsed = parseName(name, "encryptionConfigs");
  return {
    name,
    encryptionConfigId: parsed.id || DEFAULT_ENCRYPTION_CONFIG_ID,
    organizationId: parsed.organization || organizationId,
    location: parsed.location,
    key: config.key,
    enableMetastoreEncryption: config.enableMetastoreEncryption === true,
    encryptionState: config.encryptionState,
    failureDetails: config.failureDetails,
    etag: config.etag,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : retryQuota(
        dataplex.getOrganizationsLocationsEncryptionConfigs({ name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const EncryptionConfigProvider = () =>
  Provider.succeed(EncryptionConfig, {
    stables: [
      "name",
      "encryptionConfigId",
      "organizationId",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId:
          olds?.encryptionConfigId ??
          output?.encryptionConfigId ??
          DEFAULT_ENCRYPTION_CONFIG_ID,
        nextId: toId(
          news.encryptionConfigId,
          olds?.encryptionConfigId ?? output?.encryptionConfigId,
        ),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.organizationId ?? output?.organizationId,
        nextParent: news.organizationId,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const encryptionConfigId = toId(
        olds?.encryptionConfigId,
        output?.encryptionConfigId,
      );
      const organizationId = olds?.organizationId ?? output?.organizationId;
      if (organizationId === undefined) return undefined;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(organizationId, location, encryptionConfigId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organizationId);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () => Effect.succeed([]),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const encryptionConfigId = toId(
        news.encryptionConfigId,
        output?.encryptionConfigId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        news.organizationId,
        location,
        encryptionConfigId,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryQuota(
          dataplex.createOrganizationsLocationsEncryptionConfigs({
            parent: orgParent(news.organizationId, location),
            encryptionConfigId,
            body: {
              key: news.key,
              enableMetastoreEncryption:
                news.enableMetastoreEncryption === true ? true : undefined,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new DataplexNotResolved({ name });
      }

      const keyChanged = (current.key ?? "") !== (news.key ?? "");
      const metastoreChanged =
        (current.enableMetastoreEncryption === true) !==
        (news.enableMetastoreEncryption === true);

      if (keyChanged || metastoreChanged) {
        const operation =
          yield* dataplex.patchOrganizationsLocationsEncryptionConfigs({
            name: current.name ?? name,
            updateMask: [
              keyChanged ? "key" : undefined,
              metastoreChanged ? "enableMetastoreEncryption" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              key: news.key,
              enableMetastoreEncryption:
                news.enableMetastoreEncryption === true,
              etag: current.etag,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, news.organizationId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dataplex
        .deleteOrganizationsLocationsEncryptionConfigs({
          name: output.name,
          etag: output.etag,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
