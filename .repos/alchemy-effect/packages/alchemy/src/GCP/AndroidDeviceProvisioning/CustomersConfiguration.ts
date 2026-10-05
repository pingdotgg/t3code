import * as androiddeviceprovisioning from "@distilled.cloud/gcp/androiddeviceprovisioning_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_IS_DEFAULT,
  encodeOwnershipLine,
  findConfigurationByName,
  findOwnedConfiguration,
  getConfiguration,
  hasOwnershipMarker,
  lastSegment,
  listOwnedConfigurations,
  MAX_CONFIGURATION_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  pickDpcName,
  replaceOnIdentity,
  sameBoolean,
  sameText,
  toConfigurationName,
  toCustomerName,
  toDisplayName,
  toDpcName,
  updateMaskOf,
} from "./internal.ts";

export type CustomersConfigurationProps = {
  /**
   * Parent customer (`customers/{customer}` or `{customer}`). Immutable
   * — changing it replaces the configuration.
   */
  parent: string;
  /**
   * Server-assigned configuration id (last path segment). Immutable —
   * changing it replaces the configuration.
   */
  configurationId?: string;
  /**
   * DPC resource (`customers/{customer}/dpcs/{dpc}` or `{dpc}`). When
   * omitted, Alchemy lists the customer's DPCs and prefers Android
   * Device Policy.
   */
  dpcResourcePath?: string;
  /**
   * Email shown to device users for help. Validated by the API.
   */
  contactEmail: string;
  /**
   * Phone number shown to device users for help. Accepts numerals,
   * spaces, `+`, hyphens, and parentheses.
   */
  contactPhone: string;
  /**
   * Organization name shown during zero-touch setup.
   */
  companyName: string;
  /**
   * Short admin-facing name. Configurations have no labels field, so
   * Alchemy stores ownership in a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  configurationName?: string;
  /**
   * JSON extras passed to the DPC at provisioning time.
   */
  dpcExtras?: string;
  /**
   * Whether newly purchased devices receive this configuration.
   * @default false
   */
  isDefault?: boolean;
  /**
   * Help text shown to the device user before provisioning.
   */
  customMessage?: string;
  /**
   * Factory-reset timeout when setup does not complete (for example
   * `"7200s"`). The API default is two hours when unset.
   */
  forcedResetTime?: string;
};

export type CustomersConfiguration = Resource<
  "GCP.AndroidDeviceProvisioning.CustomersConfiguration",
  CustomersConfigurationProps,
  {
    /** Resource name `customers/{customer}/configurations/{configuration}`. */
    name: string;
    /** Configuration id (last path segment). */
    configurationId: string;
    /** Parent customer name `customers/{customer}`. */
    parent: string;
    /** Project id used when the configuration was reconciled. */
    project: string;
    /** Admin-facing name with the Alchemy ownership prefix stripped. */
    configurationName: string | undefined;
    /** DPC resource path applied to devices. */
    dpcResourcePath: string | undefined;
    /** JSON extras passed to the DPC. */
    dpcExtras: string | undefined;
    /** Organization name shown during setup. */
    companyName: string | undefined;
    /** Help email shown to device users. */
    contactEmail: string | undefined;
    /** Help phone shown to device users. */
    contactPhone: string | undefined;
    /** Help message shown before provisioning. */
    customMessage: string | undefined;
    /** Whether this is the customer's default configuration. */
    isDefault: boolean | undefined;
    /** Factory-reset timeout duration. */
    forcedResetTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zero-touch enrollment configuration
 * (`customers/{customer}/configurations/{configuration}`).
 *
 * Configurations have no labels field, so Alchemy stamps ownership into
 * `configurationName` for `list` / nuke. Parent customer and
 * configuration id are identity — changing either replaces the
 * configuration. Contact fields, DPC, extras, default flag, custom
 * message, and reset timeout update in place. Create requires a
 * zero-touch customer the caller can administer.
 *
 * ### Creating a Configuration
 * **Example:** Named sales profile
 * ```typescript
 * const config = yield* GCP.AndroidDeviceProvisioning.CustomersConfiguration(
 *   "Sales",
 *   {
 *     parent: "customers/123456789",
 *     dpcResourcePath: "customers/123456789/dpcs/abc",
 *     companyName: "Acme",
 *     contactEmail: "it@example.com",
 *     contactPhone: "+1 555 0100",
 *     configurationName: "Sales team",
 *   },
 * );
 * ```
 *
 * **Example:** Default configuration for new devices
 * ```typescript
 * const config = yield* GCP.AndroidDeviceProvisioning.CustomersConfiguration(
 *   "Default",
 *   {
 *     parent: customer,
 *     dpcResourcePath: dpc,
 *     companyName: "Acme",
 *     contactEmail: "it@example.com",
 *     contactPhone: "+1 555 0100",
 *     isDefault: true,
 *   },
 * );
 * ```
 *
 * ### Updating a Configuration
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Rename and change the help email
 * ```typescript
 * const config = yield* GCP.AndroidDeviceProvisioning.CustomersConfiguration(
 *   "Sales",
 *   {
 *     parent: customer,
 *     dpcResourcePath: dpc,
 *     contactEmail: "help@example.com",
 *     contactPhone: "+1 555 0100",
 *     configurationName: "Field sales",
 *   },
 * );
 * ```
 *
 * @resource
 * @category AndroidDeviceProvisioning
 */
export const CustomersConfiguration = Resource<CustomersConfiguration>(
  "GCP.AndroidDeviceProvisioning.CustomersConfiguration",
);

export class CustomersConfigurationNotResolved extends Data.TaggedError(
  "GCP.AndroidDeviceProvisioning.CustomersConfigurationNotResolved",
)<{
  parent: string;
  name: string;
}> {}

const lookupName = (
  parent: string,
  configurationId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName && existingName.length > 0) return existingName;
  return toConfigurationName(parent, configurationId);
};

const toAttrs = (
  row: androiddeviceprovisioning.Configuration,
  project: string,
) => {
  const name = row.name ?? "";
  return {
    name,
    configurationId: row.configurationId ?? lastSegment(name),
    parent: parentOf(name) || toCustomerName(name),
    project,
    configurationName: parseOwnership(row.configurationName).text,
    dpcResourcePath: row.dpcResourcePath,
    dpcExtras: row.dpcExtras,
    companyName: row.companyName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    customMessage: row.customMessage,
    isDefault: row.isDefault,
    forcedResetTime: row.forcedResetTime,
  };
};

const desiredBody = (input: {
  news: CustomersConfigurationProps;
  configurationName: string;
  dpcResourcePath: string;
  current?: androiddeviceprovisioning.Configuration;
}): androiddeviceprovisioning.Configuration => ({
  configurationName: input.configurationName,
  dpcResourcePath: input.dpcResourcePath,
  contactEmail: input.news.contactEmail,
  contactPhone: input.news.contactPhone,
  companyName: input.news.companyName,
  dpcExtras: input.news.dpcExtras ?? input.current?.dpcExtras,
  isDefault:
    input.news.isDefault ?? input.current?.isDefault ?? DEFAULT_IS_DEFAULT,
  customMessage: input.news.customMessage ?? input.current?.customMessage,
  forcedResetTime: input.news.forcedResetTime ?? input.current?.forcedResetTime,
});

export const CustomersConfigurationProvider = () =>
  Provider.succeed(CustomersConfiguration, {
    stables: ["name", "configurationId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: news.parent,
        previousId: olds?.configurationId ?? output?.configurationId,
        nextId: news.configurationId,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toCustomerName(olds?.parent ?? output?.parent ?? "");
      const name = lookupName(
        parent,
        olds?.configurationId ?? output?.configurationId,
        output?.name,
      );
      let existing = yield* getConfiguration(name);
      if (existing === undefined) {
        existing = yield* findOwnedConfiguration(id, parent);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.configurationName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listOwnedConfigurations();
        return rows
          .filter((row) => hasOwnershipMarker(row.configurationName))
          .map((row) => toAttrs(row, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toCustomerName(news.parent);
      const ownership = yield* ownershipLabels(id);
      const rawName = yield* toDisplayName(
        id,
        news.configurationName,
        output?.configurationName,
      );
      const configurationName = encodeOwnershipLine(
        ownership,
        rawName,
        MAX_CONFIGURATION_NAME_LENGTH,
      );
      const dpcResourcePath = news.dpcResourcePath
        ? toDpcName(parent, news.dpcResourcePath)
        : (output?.dpcResourcePath ?? (yield* pickDpcName(parent)) ?? "");
      const name = lookupName(
        parent,
        news.configurationId ?? output?.configurationId,
        output?.name,
      );

      let current = yield* getConfiguration(name);
      if (current === undefined) {
        current = yield* findOwnedConfiguration(id, parent);
      }
      if (current === undefined) {
        current = yield* findConfigurationByName(configurationName, parent);
      }

      if (current === undefined) {
        const created = yield* androiddeviceprovisioning
          .createCustomersConfigurations({
            parent,
            body: desiredBody({
              news,
              configurationName,
              dpcResourcePath,
            }),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findConfigurationByName(configurationName, parent),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersConfigurationNotResolved({
          parent,
          name: name || configurationName,
        });
      }

      const desiredDpcResourcePath =
        dpcResourcePath.length > 0
          ? dpcResourcePath
          : (current.dpcResourcePath ?? "");
      const desired = desiredBody({
        news,
        configurationName,
        dpcResourcePath: desiredDpcResourcePath,
        current,
      });
      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(
        !sameText(current.configurationName, desired.configurationName)
          ? "configurationName"
          : undefined,
        desiredDpcResourcePath.length > 0 &&
          !sameText(current.dpcResourcePath, desiredDpcResourcePath)
          ? "dpcResourcePath"
          : undefined,
        news.dpcExtras !== undefined &&
          !sameText(current.dpcExtras, desired.dpcExtras)
          ? "dpcExtras"
          : undefined,
        !sameText(current.companyName, desired.companyName)
          ? "companyName"
          : undefined,
        !sameText(current.contactEmail, desired.contactEmail)
          ? "contactEmail"
          : undefined,
        !sameText(current.contactPhone, desired.contactPhone)
          ? "contactPhone"
          : undefined,
        news.customMessage !== undefined &&
          !sameText(current.customMessage, desired.customMessage)
          ? "customMessage"
          : undefined,
        news.isDefault !== undefined &&
          !sameBoolean(current.isDefault, desired.isDefault)
          ? "isDefault"
          : undefined,
        news.forcedResetTime !== undefined &&
          !sameText(current.forcedResetTime, desired.forcedResetTime)
          ? "forcedResetTime"
          : undefined,
      );

      if (updateMask.length > 0 && currentName.length > 0) {
        current = yield* androiddeviceprovisioning.patchCustomersConfigurations(
          {
            name: currentName,
            updateMask,
            body: desired,
          },
        );
      }

      const fresh =
        (yield* getConfiguration(current.name ?? currentName)) ?? current;
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* androiddeviceprovisioning
        .deleteCustomersConfigurations({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
        );
    }),
  });
