import * as chromemanagement from "@distilled.cloud/gcp/chromemanagement_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  detailsNeedSync,
  encodeOwnershipLine,
  findConnectorConfigByName,
  findOwnedConnectorConfig,
  getConnectorConfig,
  hasOwnershipMarker,
  lastSegment,
  listOwnedConnectorConfigs,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  sameText,
  toConnectorConfigId,
  toConnectorConfigName,
  toCustomerName,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type ConnectorConfigDetails =
  chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfigDetails;
export type ConnectorConfigType =
  | chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfigTypeEnum
  | (string & {});
export type ConnectorConfigStatus =
  chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfigStatus;

export type CustomersConnectorConfigProps = {
  /**
   * Parent customer (`customers/{customer}` or `{customer}`). Immutable
   * — changing it replaces the connector config.
   */
  parent: string;
  /**
   * Connector config id (last path segment). If omitted, a unique id is
   * generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the connector config.
   */
  connectorConfigId?: string;
  /**
   * Admin-facing display name. Connector configs have no labels field,
   * so Alchemy stores ownership in a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  displayName?: string;
  /**
   * Connector type (`REPORTING`, `DEVICE_TRUST`, `XDR`,
   * `IDENTITY_BASED_ENROLLMENT`, `CERTIFICATE_AUTHORITY`, `ROOT_STORE`,
   * `CONTENT_ANALYSIS`). Immutable — changing it replaces the connector
   * config.
   */
  type: ConnectorConfigType;
  /**
   * Type-specific connector details (Pub/Sub, Splunk, CrowdStrike,
   * device trust, MIP, …). `apiKey` and `hecToken` fields are input-only
   * and are not returned by get.
   */
  details: ConnectorConfigDetails;
};

export type CustomersConnectorConfig = Resource<
  "GCP.ChromeManagement.CustomersConnectorConfig",
  CustomersConnectorConfigProps,
  {
    /** Resource name `customers/{customer}/connectorConfigs/{connector_config}`. */
    name: string;
    /** Connector config id (last path segment). */
    connectorConfigId: string;
    /** Parent customer name `customers/{customer}`. */
    parent: string;
    /** Project id used when the connector config was reconciled. */
    project: string;
    /** Display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Connector type. */
    type: string | undefined;
    /** Type-specific connector details. Input-only secrets are omitted. */
    details: ConnectorConfigDetails | undefined;
    /** Server-reported connector status. */
    status: ConnectorConfigStatus | undefined;
  },
  never,
  Providers
>;

/**
 * A Chrome Management connector config
 * (`customers/{customer}/connectorConfigs/{connector_config}`).
 *
 * Connector configs have no labels field, so Alchemy stamps ownership
 * into `displayName` for `list` / nuke. Parent, connector config id, and
 * type are identity — changing any of them replaces the config. Display
 * name and details update in place. Create requires a Chrome Enterprise
 * customer the caller can administer.
 *
 * ### Creating a Connector Config
 * **Example:** Pub/Sub reporting connector
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("chrome-events", {});
 * const config = yield* GCP.ChromeManagement.CustomersConnectorConfig(
 *   "Reporting",
 *   {
 *     parent: "customers/my_customer",
 *     type: "REPORTING",
 *     displayName: "Alchemy reporting",
 *     details: {
 *       pubSubConfig: {
 *         topicFullPath: topic.name,
 *         reportingSettings: {
 *           enabledDefaultEvents: ["ALL_DEFAULT_EVENTS"],
 *         },
 *       },
 *     },
 *   },
 * );
 * ```
 *
 * **Example:** Device trust connector
 * ```typescript
 * const config = yield* GCP.ChromeManagement.CustomersConnectorConfig(
 *   "Trust",
 *   {
 *     parent: "customers/C01234567",
 *     type: "DEVICE_TRUST",
 *     displayName: "Okta device trust",
 *     details: {
 *       deviceTrustConfig: {
 *         serviceProvider: "OKTA",
 *         urlMatchers: ["https://login.example.com"],
 *         serviceAccounts: ["trust@example.com"],
 *         scope: "BROWSERS_ONLY",
 *       },
 *     },
 *   },
 * );
 * ```
 *
 * ### Updating a Connector Config
 * **Example:** Rename and change reporting events
 * ```typescript
 * const config = yield* GCP.ChromeManagement.CustomersConnectorConfig(
 *   "Reporting",
 *   {
 *     parent: "customers/my_customer",
 *     type: "REPORTING",
 *     displayName: "Alchemy reporting (prod)",
 *     details: {
 *       pubSubConfig: {
 *         topicFullPath: topic.name,
 *         reportingSettings: {
 *           enabledDefaultEvents: ["BROWSER_CRASH_EVENT"],
 *           enabledOptInEvents: ["ALL_OPT_IN_EVENTS"],
 *         },
 *       },
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category ChromeManagement
 */
export const CustomersConnectorConfig = Resource<CustomersConnectorConfig>(
  "GCP.ChromeManagement.CustomersConnectorConfig",
);

export class CustomersConnectorConfigNotResolved extends Data.TaggedError(
  "GCP.ChromeManagement.CustomersConnectorConfigNotResolved",
)<{
  parent: string;
  name: string;
}> {}

const lookupName = (
  parent: string,
  connectorConfigId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName && existingName.length > 0) return existingName;
  return toConnectorConfigName(parent, connectorConfigId);
};

const toAttrs = (
  row: chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfig,
  project: string,
) => {
  const name = row.name ?? "";
  return {
    name,
    connectorConfigId: lastSegment(name),
    parent: parentOf(name) || toCustomerName(name),
    project,
    displayName: parseOwnership(row.displayName).text,
    type: row.type,
    details: row.details,
    status: row.status,
  };
};

const desiredBody = (input: {
  news: CustomersConnectorConfigProps;
  displayName: string;
}): chromemanagement.GoogleChromeManagementVersionsV1ConnectorConfig => ({
  displayName: input.displayName,
  type: input.news.type,
  details: input.news.details,
});

export const CustomersConnectorConfigProvider = () =>
  Provider.succeed(CustomersConnectorConfig, {
    stables: ["name", "connectorConfigId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: news.parent,
        previousId: olds?.connectorConfigId ?? output?.connectorConfigId,
        nextId: news.connectorConfigId,
        previousType: olds?.type ?? output?.type,
        nextType: news.type,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toCustomerName(olds?.parent ?? output?.parent ?? "");
      const connectorConfigId = yield* toConnectorConfigId(
        id,
        olds?.connectorConfigId ?? output?.connectorConfigId,
        output?.connectorConfigId,
      );
      const name = lookupName(parent, connectorConfigId, output?.name);
      let existing = yield* getConnectorConfig(name);
      if (existing === undefined) {
        existing = yield* findOwnedConnectorConfig(id, parent);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listOwnedConnectorConfigs();
        return rows
          .filter((row) => hasOwnershipMarker(row.displayName))
          .map((row) => toAttrs(row, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output, olds }) {
      const env = yield* GcpEnvironment.current;
      const parent = toCustomerName(news.parent);
      const ownership = yield* ownershipLabels(id);
      const rawName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        rawName,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const connectorConfigId = yield* toConnectorConfigId(
        id,
        news.connectorConfigId,
        output?.connectorConfigId,
      );
      const name = lookupName(parent, connectorConfigId, output?.name);
      const desired = desiredBody({ news, displayName });

      let current = yield* getConnectorConfig(name);
      if (current === undefined) {
        current = yield* findOwnedConnectorConfig(id, parent);
      }
      if (current === undefined) {
        current = yield* findConnectorConfigByName(displayName, parent);
      }

      if (current === undefined) {
        const created = yield* chromemanagement
          .createCustomersConnectorConfigs({
            parent,
            connectorConfigId,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getConnectorConfig(name).pipe(
                Effect.flatMap((row) =>
                  row !== undefined
                    ? Effect.succeed(row)
                    : findConnectorConfigByName(displayName, parent),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersConnectorConfigNotResolved({
          parent,
          name: name || displayName,
        });
      }

      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(
        !sameText(current.displayName, desired.displayName)
          ? "displayName"
          : undefined,
        detailsNeedSync(current.details, desired.details, olds?.details)
          ? "details"
          : undefined,
      );

      if (updateMask.length > 0 && currentName.length > 0) {
        current = yield* chromemanagement.patchCustomersConnectorConfigs({
          name: currentName,
          updateMask,
          body: desired,
        });
      }

      const fresh =
        (yield* getConnectorConfig(current.name ?? currentName)) ?? current;
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* chromemanagement
        .deleteCustomersConnectorConfigs({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
        );
    }),
  });
