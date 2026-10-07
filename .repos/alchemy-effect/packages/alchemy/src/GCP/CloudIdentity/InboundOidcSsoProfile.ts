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
  findOwnedOidcProfile,
  getOidcProfile,
  hasOwnershipMarker,
  lastSegment,
  listOidcProfiles,
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

export type InboundOidcSsoProfileIdpConfig = {
  /** IdP issuer URL. Discovery is derived from this URI. */
  issuerUri?: string;
  /** HTTPS change-password URL. */
  changePasswordUri?: string;
};

export type InboundOidcSsoProfileRpConfig = {
  /** OAuth2 client id. */
  clientId?: string;
  /** OAuth2 client secret (input only). */
  clientSecret?: string;
};

export type InboundOidcSsoProfileProps = {
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
   * OIDC identity provider configuration.
   */
  idpConfig?: InboundOidcSsoProfileIdpConfig;
  /**
   * OIDC relying-party configuration. `clientSecret` is input-only.
   */
  rpConfig?: InboundOidcSsoProfileRpConfig;
};

export type InboundOidcSsoProfile = Resource<
  "GCP.CloudIdentity.InboundOidcSsoProfile",
  InboundOidcSsoProfileProps,
  {
    /** Resource name `inboundOidcSsoProfiles/{id}`. */
    name: string;
    /** Profile id (last path segment). */
    profileId: string;
    /** Customer. */
    customer: string | undefined;
    /** Display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** IdP configuration. */
    idpConfig: InboundOidcSsoProfileIdpConfig | undefined;
    /** RP configuration (secret omitted). */
    rpConfig:
      | {
          clientId?: string;
          redirectUris?: string[];
        }
      | undefined;
  },
  never,
  Providers
>;

/**
 * An inbound OIDC SSO profile for a Google enterprise customer.
 *
 * Profiles have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. `customer` is identity; display
 * name and IdP / RP config update in place.
 *
 * ### Creating a Profile
 * **Example:** Basic OIDC IdP
 * ```typescript
 * const profile = yield* GCP.CloudIdentity.InboundOidcSsoProfile("Okta", {
 *   displayName: "Okta",
 *   idpConfig: { issuerUri: "https://idp.example.com" },
 *   rpConfig: { clientId: "google-rp", clientSecret: "secret" },
 * });
 * ```
 *
 * @resource
 * @category CloudIdentity
 */
export const InboundOidcSsoProfile = Resource<InboundOidcSsoProfile>(
  "GCP.CloudIdentity.InboundOidcSsoProfile",
);

export class InboundOidcSsoProfileNotResolved extends Data.TaggedError(
  "GCP.CloudIdentity.InboundOidcSsoProfileNotResolved",
)<{
  name: string;
}> {}

const rpOf = (rp: cloudidentity.OidcRpConfig | undefined) => {
  if (rp === undefined) return undefined;
  return {
    clientId: rp.clientId,
    redirectUris: rp.redirectUris,
  };
};

const toAttrs = (profile: cloudidentity.InboundOidcSsoProfile) => {
  const name = profile.name ?? "";
  return {
    name,
    profileId: lastSegment(name),
    customer: profile.customer,
    displayName: parseOwnership(profile.displayName).text,
    idpConfig: profile.idpConfig
      ? {
          issuerUri: profile.idpConfig.issuerUri,
          changePasswordUri: profile.idpConfig.changePasswordUri,
        }
      : undefined,
    rpConfig: rpOf(profile.rpConfig),
  };
};

const observeProfile = (input: { id: string; name?: string }) =>
  Effect.gen(function* () {
    const byName = yield* getOidcProfile(input.name ?? "");
    if (byName !== undefined) return byName;
    return yield* findOwnedOidcProfile(input.id);
  });

export const InboundOidcSsoProfileProvider = () =>
  Provider.succeed(InboundOidcSsoProfile, {
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
        const profiles = yield* listOidcProfiles();
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
      const desired: cloudidentity.InboundOidcSsoProfile = {
        customer,
        displayName,
        idpConfig: news.idpConfig,
        rpConfig: news.rpConfig,
      };

      let current = yield* observeProfile({ id, name: output?.name });

      if (current === undefined) {
        const created = yield* cloudidentity
          .createInboundOidcSsoProfiles({ body: desired })
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
            current = yield* getOidcProfile(createdName);
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
        return yield* new InboundOidcSsoProfileNotResolved({
          name: output?.name ?? displayName,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const idpChanged = !sameJson(current.idpConfig, news.idpConfig ?? {});
      const rpChanged =
        news.rpConfig !== undefined &&
        (!sameText(current.rpConfig?.clientId, news.rpConfig.clientId) ||
          news.rpConfig.clientSecret !== undefined);
      const updateMask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        idpChanged ? "idp_config" : undefined,
        rpChanged ? "rp_config" : undefined,
      );

      if (updateMask.length > 0 && name.length > 0) {
        const patched = yield* cloudidentity.patchInboundOidcSsoProfiles({
          name,
          updateMask,
          body: {
            displayName,
            idpConfig: news.idpConfig,
            rpConfig: news.rpConfig,
          },
        });
        yield* waitForOperation(patched).pipe(
          Effect.catchTag(
            "GCP.CloudIdentity.OperationPending",
            () => Effect.void,
          ),
        );
        current = (yield* getOidcProfile(name)) ?? current;
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      const deleted = yield* cloudidentity
        .deleteInboundOidcSsoProfiles({ name: output.name })
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
