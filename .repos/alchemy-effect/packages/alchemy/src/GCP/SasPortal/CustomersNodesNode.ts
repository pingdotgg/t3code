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
  expandPath,
  findOwnedCustomerNodeNode,
  getNodeNode,
  hasOwnershipMarker,
  lastSegment,
  listCustomerNodeNodes,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  retryDelete,
  sameStringList,
  sameText,
  scanOwnedCustomerNodeNode,
  toDisplayName,
  updateMaskOf,
  waitUntilGone,
  walkCustomerNodes,
} from "./internal.ts";

export type CustomersNodesNodeProps = {
  /**
   * Parent SAS node, as `customers/{customer}/nodes/{node}`.
   * Immutable — changing it replaces the child node.
   */
  parent: string;
  /**
   * Server-assigned node resource name (`customers/{customer}/nodes/{node}/nodes/{node}`).
   * Immutable — changing it replaces the node.
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

export type CustomersNodesNode = Resource<
  "GCP.SasPortal.CustomersNodesNode",
  CustomersNodesNodeProps,
  {
    /** Resource name `customers/{customer}/nodes/{node}/nodes/{node}`. */
    name: string;
    /** Node id (last path segment). */
    nodeId: string;
    /** Parent resource name. */
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
 * A Spectrum Access System (SAS) Portal node nested under a customer node.
 *
 * SAS Portal nodes have no labels field, so Alchemy stamps ownership
 * into `displayName` for `list` / nuke. Parent is identity. Display
 * name and SAS user ids update in place.
 *
 * ### Creating a Child Node
 * **Example:** Nested node
 * ```typescript
 * const child = yield* GCP.SasPortal.CustomersNodesNode("Sector", {
 *   parent: node.name,
 *   displayName: "sector-1",
 * });
 * ```
 *
 * ### Updating a Child Node
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename
 * ```typescript
 * const child = yield* GCP.SasPortal.CustomersNodesNode("Sector", {
 *   parent: node.name,
 *   displayName: "sector-1-2",
 * });
 * ```
 *
 * @resource
 * @category SasPortal
 */
export const CustomersNodesNode = Resource<CustomersNodesNode>(
  "GCP.SasPortal.CustomersNodesNode",
);

export class CustomersNodesNodeNotResolved extends Data.TaggedError(
  "GCP.SasPortal.CustomersNodesNodeNotResolved",
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

export const CustomersNodesNodeProvider = () =>
  Provider.succeed(CustomersNodesNode, {
    stables: ["name", "nodeId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: expandPath(news.parent),
        previousId: olds?.name ?? output?.name,
        nextId: news.name,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandPath(olds?.parent ?? output?.parent ?? "");
      const name = olds?.name ?? output?.name ?? "";
      let existing = yield* getNodeNode(name);
      let locatedParent = existing
        ? parentOf(existing.name ?? "") || parent
        : parent;
      if (existing === undefined) {
        const found =
          (yield* findOwnedCustomerNodeNode(id, parent)) ??
          (yield* scanOwnedCustomerNodeNode(id, parent));
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
        const parents = yield* walkCustomerNodes();
        const pages = yield* Effect.forEach(
          parents,
          (entry) => {
            const parent = entry.node.name ?? "";
            return parent.length === 0
              ? Effect.succeed([])
              : listCustomerNodeNodes(parent).pipe(
                  Effect.map((rows) =>
                    rows
                      .filter((row) => hasOwnershipMarker(row.displayName))
                      .map((row) => toAttrs(row, parent, env.project)),
                  ),
                );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandPath(news.parent);
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

      let current = yield* getNodeNode(news.name ?? output?.name ?? "");
      if (current === undefined) {
        const found =
          (yield* findOwnedCustomerNodeNode(id, parent)) ??
          (yield* scanOwnedCustomerNodeNode(id, parent));
        current = found?.row;
      }

      if (current === undefined) {
        const created = yield* sasportal
          .createCustomersNodesNodes({
            parent,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedCustomerNodeNode(id, parent).pipe(
                Effect.map((found) => found?.row),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersNodesNodeNotResolved({
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
        current = yield* sasportal.patchNodesNodes({
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
        sasportal.deleteNodesNodes({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getNodeNode(output.name));
    }),
  });
