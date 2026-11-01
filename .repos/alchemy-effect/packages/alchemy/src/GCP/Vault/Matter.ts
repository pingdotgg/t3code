import * as vault from "@distilled.cloud/gcp/vault_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  closeThenDeleteMatter,
  encodeOwnership,
  findOwnedMatter,
  getMatter,
  hasOwnershipMarker,
  listActiveMatters,
  MAX_MATTER_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  toGeneratedName,
} from "./internal.ts";

export type MatterPermission = {
  /** Collaborator role (`COLLABORATOR` or `OWNER`). */
  role?: vault.MatterPermissionRoleEnum | (string & {});
  /** Admin SDK account id. */
  accountId?: string;
};

export type MatterProps = {
  /**
   * Server-assigned matter id. Leave blank on create. Immutable —
   * changing it replaces the matter.
   */
  matterId?: string;
  /**
   * Display name (max 100 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id.
   */
  name?: string;
  /**
   * Optional description. Vault matters have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  description?: string;
  /**
   * Requested data region. Immutable — changing it replaces the matter.
   */
  matterRegion?: vault.MatterMatterRegionEnum | (string & {});
  /**
   * Desired matter state. Reconcile keeps the matter `OPEN` unless this
   * is set to `CLOSED`.
   */
  state?: vault.MatterStateEnum | (string & {});
};

export type Matter = Resource<
  "GCP.Vault.Matter",
  MatterProps,
  {
    /** Server-assigned matter id. */
    matterId: string;
    /** Project id used when the matter was reconciled. */
    project: string;
    /** Display name. */
    name: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Data region. */
    matterRegion: string | undefined;
    /** Matter state (`OPEN`, `CLOSED`, or `DELETED`). */
    state: string | undefined;
    /** Collaborators. */
    matterPermissions: MatterPermission[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Vault matter (eDiscovery case).
 *
 * Vault matters have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. The server-assigned id and data region
 * are identity — changing either replaces the matter. Name and description
 * update in place. Delete closes the matter first, then soft-deletes it.
 *
 * ### Creating a Matter
 * **Example:** Generated name
 * ```typescript
 * const matter = yield* GCP.Vault.Matter("Case", {});
 * ```
 *
 * **Example:** Explicit name and description
 * ```typescript
 * const matter = yield* GCP.Vault.Matter("Case", {
 *   name: "Acme v Contoso",
 *   description: "litigation hold",
 *   matterRegion: "US",
 * });
 * ```
 *
 * ### Updating a Matter
 * **Example:** Rename
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const matter = yield* GCP.Vault.Matter("Case", {
 *   name: "Acme v Contoso 2026",
 *   description: "litigation hold",
 * });
 * ```
 *
 * @resource
 * @category Vault
 */
export const Matter = Resource<Matter>("GCP.Vault.Matter");

export class MatterNotResolved extends Data.TaggedError(
  "GCP.Vault.MatterNotResolved",
)<{
  matterId: string;
}> {}

const permissionsOf = (
  permissions: vault.MatterPermissionList | undefined,
): MatterPermission[] | undefined => {
  if (permissions === undefined) return undefined;
  return permissions.map((permission) => ({
    role: permission.role,
    accountId: permission.accountId,
  }));
};

const toAttrs = (matter: vault.Matter, project: string) => ({
  matterId: matter.matterId ?? "",
  project,
  name: matter.name ?? "",
  description: parseOwnership(matter.description).text,
  matterRegion: matter.matterRegion,
  state: matter.state,
  matterPermissions: permissionsOf(matter.matterPermissions),
});

const ensureOpen = (matter: vault.Matter) =>
  Effect.gen(function* () {
    const matterId = matter.matterId ?? "";
    if (matterId.length === 0) return matter;
    if (matter.state === "DELETED") {
      return yield* vault.undeleteMatters({ matterId, body: {} });
    }
    if (matter.state === "CLOSED") {
      const reopened = yield* vault.reopenMatters({ matterId, body: {} });
      return reopened.matter ?? matter;
    }
    return matter;
  });

export const MatterProvider = () =>
  Provider.succeed(Matter, {
    stables: ["matterId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.matterId ?? output?.matterId;
      if (
        previousId !== undefined &&
        news.matterId !== undefined &&
        news.matterId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousRegion = olds?.matterRegion ?? output?.matterRegion;
      if (
        previousRegion !== undefined &&
        news.matterRegion !== undefined &&
        news.matterRegion !== previousRegion
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const matterId = olds?.matterId ?? output?.matterId ?? "";
      let existing = yield* getMatter(matterId);
      if (existing === undefined || existing.state === "DELETED") {
        existing = yield* findOwnedMatter(id);
      }
      if (existing === undefined || existing.state === "DELETED") {
        return undefined;
      }
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const matters = yield* listActiveMatters();
        return matters
          .filter((matter) => hasOwnershipMarker(matter.description))
          .map((matter) => toAttrs(matter, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* ownershipLabels(id);
      const name = yield* toGeneratedName(
        id,
        news.name,
        output?.name,
        MAX_MATTER_NAME_LENGTH,
      );
      const description = encodeOwnership(ownership, news.description);
      const desired: vault.Matter = {
        name,
        description,
        matterRegion: news.matterRegion,
      };

      let current = yield* getMatter(news.matterId ?? output?.matterId ?? "");
      if (current === undefined || current.state === "DELETED") {
        const owned = yield* findOwnedMatter(id);
        if (owned !== undefined) current = owned;
      }

      if (current === undefined || current.state === "DELETED") {
        if (current?.state === "DELETED" && current.matterId) {
          current = yield* vault.undeleteMatters({
            matterId: current.matterId,
            body: {},
          });
        } else {
          const created = yield* vault
            .createMatters({ body: desired })
            .pipe(Effect.catchTag("Conflict", () => findOwnedMatter(id)));
          current = created ?? undefined;
        }
      }

      if (current === undefined) {
        return yield* new MatterNotResolved({
          matterId: news.matterId ?? output?.matterId ?? name,
        });
      }

      if (news.state === "CLOSED") {
        if (current.state === "DELETED") {
          current = yield* vault.undeleteMatters({
            matterId: current.matterId ?? "",
            body: {},
          });
        }
        if (current.state === "OPEN") {
          const closed = yield* vault.closeMatters({
            matterId: current.matterId ?? "",
            body: {},
          });
          current = closed.matter ?? current;
        }
      } else {
        current = yield* ensureOpen(current);
      }

      const matterId = current.matterId ?? "";
      const nameChanged = !sameText(current.name, name);
      const descriptionChanged = !sameText(current.description, description);
      if (nameChanged || descriptionChanged) {
        current = yield* vault.updateMatters({
          matterId,
          body: { name, description },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* closeThenDeleteMatter(output.matterId);
    }),
  });
