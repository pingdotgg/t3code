import * as sasportal from "@distilled.cloud/gcp/sasportal_v1alpha1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  expandCustomer,
  findOwnedCustomerNode,
  getCustomerNode,
  hasOwnershipMarker,
  lastSegment,
  listCustomerNodes,
  listCustomers,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  retryDelete,
  sameStringList,
  sameText,
  scanOwnedCustomerNode,
  toDisplayName,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type CustomersNodeProps = {
  /**
   * Parent SAS customer, as `customers/{customer}` or the customer id.
   * Immutable — changing it replaces the node.
   */
  parent: string;
  /**
   * Server-assigned node resource name
   * (`customers/{customer}/nodes/{node}`). Immutable — changing it
   * replaces the node.
   */
  name?: string;
  /**
   * Display name. SAS Portal nodes have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  displayName?: string;
  /**
   * SAS user ids used by devices that belong to this node.
   */
  sasUserIds?: string[];
};

export type CustomersNode = Resource<
  "GCP.SasPortal.CustomersNode",
  CustomersNodeProps,
  {
    /** Resource name `customers/{customer}/nodes/{node}`. */
    name: string;
    /** Node id (last path segment). */
    nodeId: string;
    /** Parent customer resource name. */
    parent: string;
    /** Project id used when the node was reconciled. */
    project: string;
    /** User-facing display name with the Alchemy prefix stripped. */
    displayName: string | undefined;
    /** SAS user ids on the node. */
    sasUserIds: string[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Spectrum Access System (SAS) Portal node under a customer.
 *
 * SAS Portal nodes have no labels field, so Alchemy stamps ownership
 * into `displayName` for `list` / nuke. Parent customer is identity.
 * Display name and SAS user ids update in place.
 *
 * ### Creating a Node
 * **Example:** Generated display name
 * ```typescript
 * const node = yield* GCP.SasPortal.CustomersNode("Region", {
 *   parent: "customers/123",
 * });
 * ```
 *
 * **Example:** Explicit name and SAS user ids
 * ```typescript
 * const node = yield* GCP.SasPortal.CustomersNode("Region", {
 *   parent: "customers/123",
 *   displayName: "west",
 *   sasUserIds: ["operator-1"],
 * });
 * ```
 *
 * ### Updating a Node
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename
 * ```typescript
 * const node = yield* GCP.SasPortal.CustomersNode("Region", {
 *   parent: "customers/123",
 *   displayName: "west-2",
 * });
 * ```
 *
 * @resource
 * @category SasPortal
 */
export const CustomersNode = Resource<CustomersNode>(
  "GCP.SasPortal.CustomersNode",
);

export class CustomersNodeNotResolved extends Data.TaggedError(
  "GCP.SasPortal.CustomersNodeNotResolved",
)<{
  parent: string;
  name: string;
}> {}

const toAttrs = (
  node: sasportal.SasPortalNode,
  parent: string,
  project: string,
) => {
  const name = node.name ?? "";
  return {
    name,
    nodeId: lastSegment(name),
    parent: parentOf(name) || parent,
    project,
    displayName: parseOwnership(node.displayName).text,
    sasUserIds: node.sasUserIds,
  };
};

export const CustomersNodeProvider = () =>
  Provider.succeed(CustomersNode, {
    stables: ["name", "nodeId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: expandCustomer(news.parent),
        previousId: olds?.name ?? output?.name,
        nextId: news.name,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandCustomer(olds?.parent ?? output?.parent ?? "");
      const name = olds?.name ?? output?.name ?? "";
      let existing = yield* getCustomerNode(name);
      let locatedParent = existing
        ? parentOf(existing.name ?? "") || parent
        : parent;
      if (existing === undefined) {
        const found =
          (yield* findOwnedCustomerNode(id, parent)) ??
          (yield* scanOwnedCustomerNode(id));
        existing = found?.row;
        locatedParent = found?.parent ?? locatedParent;
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, locatedParent, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const customers = yield* listCustomers();
        const pages = yield* Effect.forEach(
          customers,
          (customer) =>
            customer.name
              ? listCustomerNodes(customer.name).pipe(
                  Effect.map((rows) =>
                    rows
                      .filter((row) => hasOwnershipMarker(row.displayName))
                      .map((row) =>
                        toAttrs(row, customer.name ?? "", env.project),
                      ),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandCustomer(news.parent);
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(id, news.displayName, output?.displayName),
        MAX_DISPLAY_NAME_LENGTH,
      );
      const desired: sasportal.SasPortalNode = {
        displayName,
        sasUserIds: news.sasUserIds,
      };

      let current = yield* getCustomerNode(news.name ?? output?.name ?? "");
      if (current === undefined) {
        const found =
          (yield* findOwnedCustomerNode(id, parent)) ??
          (yield* scanOwnedCustomerNode(id));
        current = found?.row;
      }

      if (current === undefined) {
        const created = yield* sasportal
          .createCustomersNodes({
            parent,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedCustomerNode(id, parent).pipe(
                Effect.map((found) => found?.row),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersNodeNotResolved({
          parent,
          name: news.name ?? output?.name ?? displayName,
        });
      }

      const name = current.name ?? news.name ?? output?.name ?? "";
      const nameChanged = !sameText(current.displayName, displayName);
      const usersChanged =
        news.sasUserIds !== undefined &&
        !sameStringList(current.sasUserIds, news.sasUserIds);
      if (nameChanged || usersChanged) {
        current = yield* sasportal.patchCustomersNodes({
          name,
          updateMask: updateMaskOf(
            "displayName",
            news.sasUserIds !== undefined ? "sasUserIds" : undefined,
          ),
          body: desired,
        });
      }

      return toAttrs(current, parent, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryDelete(
        sasportal.deleteCustomersNodes({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getCustomerNode(output.name));
    }),
  });
