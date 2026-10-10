import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  findOwnedSamlProfile,
  getSamlProfile,
  hasOwnershipMarker,
  lastSegment,
  listSamlProfiles,
  MAX_DISPLAY_NAME_LENGTH,
  normalizeCustomer,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";
import {
  resourceNameFromOperation,
  waitForOperation,
  waitUntilPresent,
} from "./operations.ts";

export type InboundSamlSsoProfileIdpConfig = {
  /** HTTPS SingleSignOnService URL (HTTP-Redirect binding). */
  singleSignOnServiceUri?: string;
  /** SAML Entity ID of the identity provider. */
  entityId?: string;
  /** HTTPS logout redirect URL. */
  logoutRedirectUri?: string;
  /** HTTPS change-password URL. */
  changePasswordUri?: string;
};

export type InboundSamlSsoProfileProps = {
  /**
   * Customer (`customers/C0123abc` or `customers/my_customer`).
   * Immutable — changing it replaces the profile.
   * @default "customers/my_customer"
   */
  customer?: string;
  /**
   * Human-readable name. Profiles have no labels field, so Alchemy
   * stamps ownership into `displayName` for `list` / nuke.
   */
  displayName?: string;
  /**
   * SAML identity provider configuration.
   */
  idpConfig?: InboundSamlSsoProfileIdpConfig;
};

export type InboundSamlSsoProfile = Resource<
  "GCP.CloudIdentity.InboundSamlSsoProfile",
  InboundSamlSsoProfileProps,
  {
    /** Resource name `inboundSamlSsoProfiles/{id}`. */
    name: string;
    /** Profile id (last path segment). */
    profileId: string;
    /** Customer. */
    customer: string | undefined;
    /** Display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** IdP configuration. */
    idpConfig: InboundSamlSsoProfileIdpConfig | undefined;
    /** Google-provided SP ACS URL. */
    assertionConsumerServiceUri: string | undefined;
    /** Google-provided SP Entity ID. */
    spEntityId: string | undefined;
  },
  never,
  Providers
>;

/**
 * An inbound SAML 2.0 SSO profile for a Google enterprise customer.
 *
 * Profiles have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. `customer` is identity; display
 * name and IdP config update in place.
 *
 * ### Creating a Profile
 * **Example:** Basic SAML IdP
 * ```typescript
 * const profile = yield* GCP.CloudIdentity.InboundSamlSsoProfile("Okta", {
 *   displayName: "Okta",
 *   idpConfig: {
 *     entityId: "https://idp.example.com/metadata",
 *     singleSignOnServiceUri: "https://idp.example.com/sso",
 *   },
 * });
 * ```
 *
 * @resource
 * @category CloudIdentity
 */
export const InboundSamlSsoProfile = Resource<InboundSamlSsoProfile>(
  "GCP.CloudIdentity.InboundSamlSsoProfile",
);

export class InboundSamlSsoProfileNotResolved extends Data.TaggedError(
  "GCP.CloudIdentity.InboundSamlSsoProfileNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (profile: cloudidentity.InboundSamlSsoProfile) => {
  const name = profile.name ?? "";
  return {
    name,
    profileId: lastSegment(name),
    customer: profile.customer,
    displayName: parseOwnership(profile.displayName).text,
    idpConfig: profile.idpConfig
      ? {
          singleSignOnServiceUri: profile.idpConfig.singleSignOnServiceUri,
          entityId: profile.idpConfig.entityId,
          logoutRedirectUri: profile.idpConfig.logoutRedirectUri,
          changePasswordUri: profile.idpConfig.changePasswordUri,
        }
      : undefined,
    assertionConsumerServiceUri: profile.spConfig?.assertionConsumerServiceUri,
    spEntityId: profile.spConfig?.entityId,
  };
};

const observeProfile = (input: { id: string; name?: string }) =>
  Effect.gen(function* () {
    const byName = yield* getSamlProfile(input.name ?? "");
    if (byName !== undefined) return byName;
    return yield* findOwnedSamlProfile(input.id);
  });

export const InboundSamlSsoProfileProvider = () =>
  Provider.succeed(InboundSamlSsoProfile, {
    stables: ["name", "profileId", "customer"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.customer ?? output?.customer;
      const next =
        news.customer !== undefined
          ? normalizeCustomer(news.customer)
          : previous;
      return replaceOnIdentity({
        previousParent: previous,
        nextParent: next,
      });
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observeProfile({ id, name: output?.name });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const profiles = yield* listSamlProfiles();
        return profiles
          .filter((profile) => hasOwnershipMarker(profile.displayName))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const ownership = yield* ownershipLabels(id);
      const customer = normalizeCustomer(news.customer ?? output?.customer);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toPhysicalId(
          id,
          news.displayName,
          output?.displayName,
          MAX_DISPLAY_NAME_LENGTH,
        ),
        MAX_DISPLAY_NAME_LENGTH,
      );
      const desired: cloudidentity.InboundSamlSsoProfile = {
        customer,
        displayName,
        idpConfig: news.idpConfig,
      };

      let current = yield* observeProfile({ id, name: output?.name });

      if (current === undefined) {
        const created = yield* cloudidentity
          .createInboundSamlSsoProfiles({ body: desired })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<cloudidentity.Operation | undefined>(undefined),
            ),
          );
        if (created !== undefined) {
          yield* waitForOperation(created).pipe(
            Effect.catchTag(
              "GCP.CloudIdentity.OperationPending",
              () => Effect.void,
            ),
          );
          const createdName = resourceNameFromOperation(created);
          if (createdName !== undefined) {
            current = yield* getSamlProfile(createdName);
          }
        }
        if (current === undefined) {
          current = yield* waitUntilPresent(
            observeProfile({ id, name: output?.name }),
            displayName,
          ).pipe(
            Effect.catchTag("GCP.CloudIdentity.OperationPending", () =>
              observeProfile({ id }),
            ),
          );
        }
      }

      if (current === undefined) {
        return yield* new InboundSamlSsoProfileNotResolved({
          name: output?.name ?? displayName,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const idpChanged = !sameJson(current.idpConfig, news.idpConfig ?? {});
      const updateMask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        idpChanged ? "idp_config" : undefined,
      );

      if (updateMask.length > 0 && name.length > 0) {
        const patched = yield* cloudidentity.patchInboundSamlSsoProfiles({
          name,
          updateMask,
          body: {
            displayName,
            idpConfig: news.idpConfig,
          },
        });
        yield* waitForOperation(patched).pipe(
          Effect.catchTag(
            "GCP.CloudIdentity.OperationPending",
            () => Effect.void,
          ),
        );
        current = (yield* getSamlProfile(name)) ?? current;
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      const deleted = yield* cloudidentity
        .deleteInboundSamlSsoProfiles({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed<cloudidentity.Operation | undefined>(undefined),
          ),
        );
      if (deleted !== undefined) {
        yield* waitForOperation(deleted, { notFoundOk: true });
      }
    }),
  });
