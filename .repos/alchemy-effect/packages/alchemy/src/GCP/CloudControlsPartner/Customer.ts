import * as cloudcontrolspartner from "@distilled.cloud/gcp/cloudcontrolspartner_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  customerName,
  encodeDisplayName,
  findOwnedCustomer,
  getCustomer,
  hasOwnershipMarker,
  listCustomers,
  listLocationParents,
  locationParent,
  normalizeLocation,
  organizationIdOf,
  organizationParent,
  ownedByAlchemy,
  ownershipLabels,
  parseName,
  parseOwnership,
  replaceOn,
  resolveOrganization,
  sameText,
  toCustomerId,
  toCustomerResourceId,
  toDisplayName,
  tryResolveOrganization,
} from "./internal.ts";

export type CustomerOnboardingState =
  cloudcontrolspartner.CustomerOnboardingState;

export type CustomerProps = {
  /**
   * Partner organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_CLOUDCONTROLSPARTNER_ORGANIZATION`,
   * `GOOGLE_ORGANIZATION_ID`, or the project's Resource Manager
   * ancestor. Immutable — changing it replaces the customer.
   */
  organization?: string;
  /**
   * Partner-operated Google Cloud location (`us-central1`, …).
   * Immutable — changing it replaces the customer. `US-CENTRAL1` is
   * accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Customer Google Cloud organization id. Becomes the last segment of
   * `organizations/{organization}/locations/{location}/customers/{customer}`.
   * Required on create and must be a valid organization id. Immutable —
   * changing it replaces the customer.
   */
  customerId?: string;
  /**
   * Display name for the customer. Cloud Controls Partner customers
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  displayName?: string;
};

export type Customer = Resource<
  "GCP.CloudControlsPartner.Customer",
  CustomerProps,
  {
    /** Resource name `organizations/{organization}/locations/{location}/customers/{customer}`. */
    name: string;
    /** Customer organization id (last path segment). */
    customerId: string;
    /** Partner organization resource name. */
    organization: string;
    /** Partner organization id. */
    organizationId: string;
    /** Location id. */
    location: string;
    /** Parent `organizations/{organization}/locations/{location}`. */
    parent: string;
    /** Project id of the deploying stack. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Customer organization domain extracted from Resource Manager. */
    organizationDomain: string | undefined;
    /** Whether the customer has finished onboarding. */
    isOnboarded: boolean;
    /** Onboarding step state reported by the partner API. */
    customerOnboardingState: CustomerOnboardingState | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Controls Partner customer of a sovereign-controls partner.
 *
 * Customers have no labels field — Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Partner organization, location, and
 * customer organization id are identity. Display name updates in place.
 *
 * Creating customers requires Cloud Controls Partner (Sovereign
 * Controls by Partners) access. The `customerId` must be the customer's
 * Google Cloud organization id.
 *
 * ### Creating a Customer
 * **Example:** Generated display name
 * ```typescript
 * const customer = yield* GCP.CloudControlsPartner.Customer("Acme", {
 *   organization: "organizations/123",
 *   location: "us-central1",
 *   customerId: "456",
 * });
 * ```
 *
 * **Example:** Explicit display name
 * ```typescript
 * const customer = yield* GCP.CloudControlsPartner.Customer("Acme", {
 *   organization: "123",
 *   customerId: "456",
 *   displayName: "Acme Corp",
 * });
 * ```
 *
 * ### Updating a Customer
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Rename
 * ```typescript
 * const customer = yield* GCP.CloudControlsPartner.Customer("Acme", {
 *   organization: "organizations/123",
 *   customerId: "456",
 *   displayName: "Acme Corporation",
 * });
 * ```
 *
 * @resource
 * @category CloudControlsPartner
 */
export const Customer = Resource<Customer>("GCP.CloudControlsPartner.Customer");

export class CustomerNotResolved extends Data.TaggedError(
  "GCP.CloudControlsPartner.CustomerNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  customer: cloudcontrolspartner.Customer,
  organization: string,
  project: string,
) => {
  const name = customer.name ?? "";
  const parsed = parseName(name);
  const org = parsed.organization || organizationParent(organization);
  return {
    name,
    customerId: parsed.customerId || toCustomerId(name) || "",
    organization: org,
    organizationId: organizationIdOf(org),
    location: parsed.location,
    parent: parsed.parent || locationParent(org, parsed.location),
    project,
    displayName: parseOwnership(customer.displayName).text,
    organizationDomain: customer.organizationDomain,
    isOnboarded: customer.isOnboarded === true,
    customerOnboardingState: customer.customerOnboardingState,
  };
};

export const CustomerProvider = () =>
  Provider.succeed(Customer, {
    stables: [
      "name",
      "customerId",
      "organization",
      "organizationId",
      "location",
      "parent",
      "project",
      "organizationDomain",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location ?? env.region,
      );
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg = news.organization;
      return (
        replaceOn(
          toCustomerId(olds?.customerId ?? output?.customerId),
          toCustomerId(news.customerId),
        ) ??
        replaceOn(
          previousOrg !== undefined
            ? organizationParent(previousOrg)
            : undefined,
          nextOrg !== undefined ? organizationParent(nextOrg) : undefined,
        ) ??
        replaceOn(previousLocation, nextLocation)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const customerId = yield* toCustomerResourceId(
        id,
        olds?.customerId ?? output?.customerId,
        output?.name,
      );
      const name =
        output?.name ?? customerName(organization, location, customerId);
      let existing = yield* getCustomer(name);
      if (existing === undefined) {
        existing = yield* findOwnedCustomer(
          id,
          locationParent(organization, location),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const pages = yield* Effect.forEach(
          listLocationParents(organization, env.region),
          (parent) => listCustomers(parent),
          { concurrency: 3 },
        );
        const byName = new Map<string, ReturnType<typeof toAttrs>>();
        for (const customer of pages.flat()) {
          if (!hasOwnershipMarker(customer.displayName)) continue;
          const attrs = toAttrs(customer, organization, env.project);
          if (attrs.name.length > 0) byName.set(attrs.name, attrs);
        }
        return [...byName.values()];
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const customerId = yield* toCustomerResourceId(
        id,
        news.customerId,
        output?.customerId ?? output?.name,
      );
      const parent = locationParent(organization, location);
      const name = customerName(organization, location, customerId);
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeDisplayName(
        ownership,
        yield* toDisplayName(id, news.displayName, output?.displayName),
      );

      let current = yield* getCustomer(output?.name ?? name);
      if (current === undefined) {
        current = yield* findOwnedCustomer(id, parent);
      }

      if (current === undefined) {
        const created = yield* cloudcontrolspartner
          .createOrganizationsLocationsCustomers({
            parent,
            customerId,
            body: { displayName },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getCustomer(name).pipe(
                Effect.flatMap((existing) =>
                  existing !== undefined
                    ? Effect.succeed(existing)
                    : findOwnedCustomer(id, parent),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomerNotResolved({ name });
      }

      const currentName = current.name ?? name;
      if (
        !sameText(current.displayName, displayName) &&
        currentName.length > 0
      ) {
        current =
          yield* cloudcontrolspartner.patchOrganizationsLocationsCustomers({
            name: currentName,
            updateMask: "display_name",
            body: { displayName },
          });
      }

      const latest =
        (yield* getCustomer(current.name ?? currentName)) ?? current;
      return toAttrs(latest, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (!name) return;
      yield* cloudcontrolspartner
        .deleteOrganizationsLocationsCustomers({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
