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
  findOwnedNodeNodeDeployment,
  getNodeDeployment,
  hasOwnershipMarker,
  lastSegment,
  listNodeNodeDeployments,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  retryDelete,
  sameStringList,
  sameText,
  scanOwnedNodeNodeDeployment,
  toDisplayName,
  updateMaskOf,
  waitUntilGone,
  walkNodeChildren,
} from "./internal.ts";

export type NodesNodesDeploymentProps = {
  /**
   * Parent nested SAS node, as `nodes/{node}/nodes/{node}`.
   * Immutable — changing it replaces the deployment.
   */
  parent: string;
  /**
   * Server-assigned deployment resource name
   * (`nodes/{node}/nodes/{node}/deployments/{deployment}`). Immutable —
   * changing it replaces the deployment.
   */
  name?: string;
  /**
   * Display name. SAS Portal deployments have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  displayName?: string;
  /**
   * SAS user ids used by devices that belong to this deployment. Each
   * deployment should have one unique user id.
   */
  sasUserIds?: string[];
};

export type NodesNodesDeployment = Resource<
  "GCP.SasPortal.NodesNodesDeployment",
  NodesNodesDeploymentProps,
  {
    /** Resource name `nodes/{node}/nodes/{node}/deployments/{deployment}`. */
    name: string;
    /** Deployment id (last path segment). */
    deploymentId: string;
    /** Parent resource name. */
    parent: string;
    /** Project id used when the deployment was reconciled. */
    project: string;
    /** User-facing display name with the Alchemy prefix stripped. */
    displayName: string | undefined;
    /** SAS user ids on the deployment. */
    sasUserIds: string[] | undefined;
    /** FCC Registration Numbers inherited from the parent. */
    frns: string[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Spectrum Access System (SAS) Portal deployment under a nested node.
 *
 * SAS Portal deployments have no labels field, so Alchemy stamps
 * ownership into `displayName` for `list` / nuke. Parent is identity.
 * Display name and SAS user ids update in place. `frns` is output-only.
 *
 * ### Creating a Deployment
 * **Example:** Explicit name and SAS user id
 * ```typescript
 * const deployment = yield* GCP.SasPortal.NodesNodesDeployment("Site", {
 *   parent: child.name,
 *   displayName: "downtown",
 *   sasUserIds: ["operator-1"],
 * });
 * ```
 *
 * ### Updating a Deployment
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename
 * ```typescript
 * const deployment = yield* GCP.SasPortal.NodesNodesDeployment("Site", {
 *   parent: child.name,
 *   displayName: "downtown-west",
 *   sasUserIds: ["operator-1"],
 * });
 * ```
 *
 * @resource
 * @category SasPortal
 */
export const NodesNodesDeployment = Resource<NodesNodesDeployment>(
  "GCP.SasPortal.NodesNodesDeployment",
);

export class NodesNodesDeploymentNotResolved extends Data.TaggedError(
  "GCP.SasPortal.NodesNodesDeploymentNotResolved",
)<{
  parent: string;
  name: string;
}> {}

const toAttrs = (
  deployment: sasportal.SasPortalDeployment,
  parent: string,
  project: string,
) => {
  const name = deployment.name ?? "";
  return {
    name,
    deploymentId: lastSegment(name),
    parent: parentOf(name) || parent,
    project,
    displayName: parseOwnership(deployment.displayName).text,
    sasUserIds: deployment.sasUserIds,
    frns: deployment.frns,
  };
};

export const NodesNodesDeploymentProvider = () =>
  Provider.succeed(NodesNodesDeployment, {
    stables: ["name", "deploymentId", "parent", "project"],

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
      let existing = yield* getNodeDeployment(name);
      let locatedParent = existing
        ? parentOf(existing.name ?? "") || parent
        : parent;
      if (existing === undefined) {
        const found =
          (yield* findOwnedNodeNodeDeployment(id, parent)) ??
          (yield* scanOwnedNodeNodeDeployment(id, parent));
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
        const parents = yield* walkNodeChildren();
        const pages = yield* Effect.forEach(
          parents,
          (entry) => {
            const parent = entry.node.name ?? "";
            return parent.length === 0
              ? Effect.succeed([])
              : listNodeNodeDeployments(parent).pipe(
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
      const desired: sasportal.SasPortalDeployment = {
        displayName,
        sasUserIds: news.sasUserIds,
      };

      let current = yield* getNodeDeployment(news.name ?? output?.name ?? "");
      if (current === undefined) {
        const found =
          (yield* findOwnedNodeNodeDeployment(id, parent)) ??
          (yield* scanOwnedNodeNodeDeployment(id, parent));
        current = found?.row;
      }

      if (current === undefined) {
        const created = yield* sasportal
          .createNodesNodesDeployments({
            parent,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedNodeNodeDeployment(id, parent).pipe(
                Effect.map((found) => found?.row),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new NodesNodesDeploymentNotResolved({
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
        current = yield* sasportal.patchNodesDeployments({
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
        sasportal.deleteNodesDeployments({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getNodeDeployment(output.name));
    }),
  });
