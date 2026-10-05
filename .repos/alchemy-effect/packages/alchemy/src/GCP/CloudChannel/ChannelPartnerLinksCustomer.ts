import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOf,
  desiredCustomer,
  findCustomerByDomain,
  getPartnerCustomer,
  jsonEqual,
  lastSegment,
  listPartnerCustomers,
  replaceOnIdentity,
  sameText,
  toChannelPartnerLinkName,
  toCustomerAttrs,
  toCustomerName,
  toDomain,
  toOrgDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type ChannelPartnerLinksCustomerProps = {
  /**
   * Channel partner link that owns the customer. Full name
   * `accounts/{account}/channelPartnerLinks/{channelPartner}` or the
   * partner id (combined with `account`). Immutable — changing it
   * replaces the customer.
   */
  parent: string;
  /**
   * Reseller account used when `parent` is a bare partner id.
   */
  account?: string;
  /**
   * Customer id (last segment of `accounts/{account}/customers/{customer}`).
   * Server-assigned on create. Immutable — changing it replaces the
   * customer.
   */
  customerId?: string;
  /**
   * Organization display name. If omitted, a unique name is generated.
   */
  orgDisplayName?: string;
  /**
   * Primary domain. Must match `primaryContactInfo.email`'s domain. If
   * omitted, a unique `{name}.example.com` domain is generated.
   */
  domain?: string;
  /**
   * Organization postal address. A US address is used when omitted.
   */
  orgPostalAddress?: cloudchannel.GoogleTypePostalAddress;
  /**
   * Primary contact. Email defaults to `admin@{domain}`.
   */
  primaryContactInfo?: cloudchannel.GoogleCloudChannelV1ContactInfo;
  /**
   * Secondary contact email used as a recovery address.
   */
  alternateEmail?: string;
  /**
   * BCP-47 language code such as `en-US`.
   * @default "en-US"
   */
  languageCode?: string;
  /**
   * External CRM id.
   */
  correlationId?: string;
  /**
   * Attestation that provided information is correct. Required for GCP
   * entitlements.
   */
  customerAttestationState?:
    | cloudchannel.GoogleCloudChannelV1CustomerCustomerAttestationStateEnum
    | (string & {});
};

export type ChannelPartnerLinksCustomer = Resource<
  "GCP.CloudChannel.ChannelPartnerLinksCustomer",
  ChannelPartnerLinksCustomerProps,
  {
    /** Resource name `accounts/{account}/customers/{customer}`. */
    name: string;
    /** Customer id (last path segment). */
    customerId: string;
    /** Channel partner link parent. */
    parent: string;
    /** Reseller account `accounts/{account}`. */
    account: string;
    /** Organization display name. */
    orgDisplayName: string | undefined;
    /** Primary domain. */
    domain: string | undefined;
    /** Organization postal address. */
    orgPostalAddress: cloudchannel.GoogleTypePostalAddress | undefined;
    /** Primary contact. */
    primaryContactInfo:
      | cloudchannel.GoogleCloudChannelV1ContactInfo
      | undefined;
    /** Alternate email. */
    alternateEmail: string | undefined;
    /** BCP-47 language code. */
    languageCode: string | undefined;
    /** External CRM id. */
    correlationId: string | undefined;
    /** Customer attestation state. */
    customerAttestationState: string | undefined;
    /** Channel partner Cloud Identity id. */
    channelPartnerId: string | undefined;
    /** Cloud Identity id, once provisioned. */
    cloudIdentityId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Channel customer created under a channel partner link.
 *
 * Partner customers have no labels field, so ownership rests on the
 * deterministic domain: `read` reports a customer it finds without prior
 * state as unowned (adopt it with `--adopt`). The channel partner link (`parent`)
 * and customer id are identity. Display name, address, contact, domain,
 * language, and attestation update in place.
 *
 * Creating partner customers requires Cloud Channel distributor access.
 *
 * ### Creating a Partner Customer
 * **Example:** Generated domain
 * ```typescript
 * const customer = yield* GCP.CloudChannel.ChannelPartnerLinksCustomer(
 *   "Resold",
 *   {
 *     parent: "accounts/C012345/channelPartnerLinks/C987654",
 *     orgDisplayName: "Resold Corp",
 *   },
 * );
 * ```
 *
 * **Example:** Explicit domain
 * ```typescript
 * const customer = yield* GCP.CloudChannel.ChannelPartnerLinksCustomer(
 *   "Resold",
 *   {
 *     parent: "accounts/C012345/channelPartnerLinks/C987654",
 *     orgDisplayName: "Resold Corp",
 *     domain: "resold.example.com",
 *     primaryContactInfo: {
 *       email: "admin@resold.example.com",
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category CloudChannel
 */
export const ChannelPartnerLinksCustomer =
  Resource<ChannelPartnerLinksCustomer>(
    "GCP.CloudChannel.ChannelPartnerLinksCustomer",
  );

export class ChannelPartnerLinksCustomerNotResolved extends Data.TaggedError(
  "GCP.CloudChannel.ChannelPartnerLinksCustomerNotResolved",
)<{
  name: string;
}> {}

const resolveParent = (newsParent: string, account?: string) =>
  toChannelPartnerLinkName(newsParent, account ?? accountOf(newsParent));

export const ChannelPartnerLinksCustomerProvider = () =>
  Provider.succeed(ChannelPartnerLinksCustomer, {
    stables: ["name", "customerId", "account", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      const nextParent = resolveParent(news.parent, news.account);
      return replaceOnIdentity({
        previousId: olds?.customerId ?? output?.customerId,
        nextId: news.customerId,
        previousParent,
        nextParent,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const parent = resolveParent(
        olds?.parent ?? output?.parent ?? "",
        olds?.account ?? output?.account,
      );
      const name = toCustomerName(
        parent,
        olds?.customerId ?? output?.customerId ?? output?.name,
      );
      let existing = yield* getPartnerCustomer(output?.name ?? name);
      if (existing === undefined) {
        const domain = yield* toDomain(id, olds?.domain, output?.domain);
        existing = yield* findCustomerByDomain(
          parent,
          domain,
          listPartnerCustomers,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toCustomerAttrs(existing, parent);
      // No labels field: without prior state the customer may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const parent = resolveParent(
        news.parent,
        news.account ?? output?.account,
      );
      const channelPartnerId = lastSegment(parent);
      const orgDisplayName = yield* toOrgDisplayName(
        id,
        news.orgDisplayName,
        output?.orgDisplayName,
      );
      const domain = yield* toDomain(id, news.domain, output?.domain);
      const body = desiredCustomer({
        orgDisplayName,
        domain,
        orgPostalAddress: news.orgPostalAddress ?? output?.orgPostalAddress,
        primaryContactInfo:
          news.primaryContactInfo ?? output?.primaryContactInfo,
        alternateEmail: news.alternateEmail,
        languageCode: news.languageCode ?? output?.languageCode,
        correlationId: news.correlationId,
        customerAttestationState: news.customerAttestationState,
        channelPartnerId,
      });
      const name = toCustomerName(
        parent,
        news.customerId ?? output?.customerId ?? output?.name,
      );

      let current = yield* getPartnerCustomer(output?.name ?? name);
      if (current === undefined) {
        current = yield* findCustomerByDomain(
          parent,
          domain,
          listPartnerCustomers,
        );
      }

      if (current === undefined) {
        const created = yield* cloudchannel
          .createAccountsChannelPartnerLinksCustomers({
            parent,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findCustomerByDomain(parent, domain, listPartnerCustomers),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ChannelPartnerLinksCustomerNotResolved({
          name: name || `${parent}/customers/${domain}`,
        });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.orgDisplayName, orgDisplayName);
      const domainChanged = !sameText(current.domain, domain);
      const addressChanged = !jsonEqual(
        current.orgPostalAddress,
        body.orgPostalAddress,
      );
      const contactChanged = !jsonEqual(
        {
          firstName: current.primaryContactInfo?.firstName,
          lastName: current.primaryContactInfo?.lastName,
          email: current.primaryContactInfo?.email,
          phone: current.primaryContactInfo?.phone,
          title: current.primaryContactInfo?.title,
        },
        {
          firstName: body.primaryContactInfo?.firstName,
          lastName: body.primaryContactInfo?.lastName,
          email: body.primaryContactInfo?.email,
          phone: body.primaryContactInfo?.phone,
          title: body.primaryContactInfo?.title,
        },
      );
      const alternateChanged = !sameText(
        current.alternateEmail,
        news.alternateEmail,
      );
      const languageChanged = !sameText(
        current.languageCode,
        body.languageCode,
      );
      const correlationChanged = !sameText(
        current.correlationId,
        news.correlationId,
      );
      const attestationChanged =
        news.customerAttestationState !== undefined &&
        !sameText(
          current.customerAttestationState,
          news.customerAttestationState,
        );

      const updateMask = updateMaskOf(
        displayChanged ? "org_display_name" : undefined,
        domainChanged ? "domain" : undefined,
        addressChanged ? "org_postal_address" : undefined,
        contactChanged ? "primary_contact_info" : undefined,
        alternateChanged ? "alternate_email" : undefined,
        languageChanged ? "language_code" : undefined,
        correlationChanged ? "correlation_id" : undefined,
        attestationChanged ? "customer_attestation_state" : undefined,
      );

      if (updateMask.length > 0 && currentName.length > 0) {
        current = yield* cloudchannel.patchAccountsChannelPartnerLinksCustomers(
          {
            name: currentName,
            updateMask,
            body,
          },
        );
      }

      return toCustomerAttrs(current, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name.length === 0) return;
      yield* cloudchannel
        .deleteAccountsChannelPartnerLinksCustomers({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
