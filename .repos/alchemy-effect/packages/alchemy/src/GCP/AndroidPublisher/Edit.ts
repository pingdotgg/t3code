import * as androidpublisher from "@distilled.cloud/gcp/androidpublisher_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getEdit, ignoreMissing } from "./internal.ts";

export type EditProps = {
  /**
   * Play package name of the app (for example `com.example.app`).
   * Immutable — changing it replaces the edit.
   */
  packageName: string;
  /**
   * Server-assigned edit id. Immutable — changing it replaces the edit.
   * An expired edit is recreated on the next reconcile.
   */
  editId?: string;
};

export type Edit = Resource<
  "GCP.AndroidPublisher.Edit",
  EditProps,
  {
    /** Server-assigned edit id. */
    editId: string;
    /** Play package name. */
    packageName: string;
    /** Project id used when the edit was reconciled. */
    project: string;
    /** Unix epoch seconds when the edit expires. */
    expiryTimeSeconds: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Play app edit (`edits`).
 *
 * An edit is a short-lived staging session for APK, listing, and track
 * changes. The API has no list method and no labels field, so `list`
 * returns an empty set — nuke cannot discover orphaned edits, and they
 * expire on their own. `packageName` and `editId` are identity. There is
 * nothing mutable to sync: reconcile observes the edit and inserts one
 * when it is missing or expired.
 *
 * ### Creating an Edit
 * **Example:** Open an edit
 * ```typescript
 * const edit = yield* GCP.AndroidPublisher.Edit("Release", {
 *   packageName: "com.example.app",
 * });
 * ```
 *
 * ### Reusing an Edit
 * **Example:** Continue an existing edit
 * ```typescript
 * const edit = yield* GCP.AndroidPublisher.Edit("Release", {
 *   packageName: "com.example.app",
 *   editId: "03487915625743125468", // an edit opened elsewhere
 * });
 * ```
 *
 * @resource
 * @category AndroidPublisher
 */
export const Edit = Resource<Edit>("GCP.AndroidPublisher.Edit");

export class EditNotResolved extends Data.TaggedError(
  "GCP.AndroidPublisher.EditNotResolved",
)<{
  packageName: string;
  editId: string;
}> {}

const toAttrs = (
  edit: androidpublisher.AppEdit,
  packageName: string,
  project: string,
) => ({
  editId: edit.id ?? "",
  packageName,
  project,
  expiryTimeSeconds: edit.expiryTimeSeconds,
});

export const EditProvider = () =>
  Provider.succeed(Edit, {
    stables: ["editId", "packageName", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPackage = olds?.packageName ?? output?.packageName;
      if (
        previousPackage !== undefined &&
        news.packageName !== previousPackage
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.editId ?? output?.editId;
      if (
        previousId !== undefined &&
        news.editId !== undefined &&
        news.editId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const packageName = olds?.packageName ?? output?.packageName ?? "";
      const editId = olds?.editId ?? output?.editId ?? "";
      const existing = yield* getEdit(packageName, editId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, packageName, env.project);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.succeed(
        [] as Array<{
          editId: string;
          packageName: string;
          project: string;
          expiryTimeSeconds: string | undefined;
        }>,
      ),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const packageName = news.packageName;
      const editId = news.editId ?? output?.editId ?? "";

      let current = yield* getEdit(packageName, editId);

      if (current === undefined) {
        const created = yield* androidpublisher
          .insertEdits({
            packageName,
            body: {},
          })
          .pipe(
            Effect.catchTag("Conflict", () => getEdit(packageName, editId)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EditNotResolved({
          packageName,
          editId,
        });
      }

      return toAttrs(current, packageName, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.packageName || !output.editId) return;
      yield* ignoreMissing(
        androidpublisher.deleteEdits({
          packageName: output.packageName,
          editId: output.editId,
        }),
      );
    }),
  });
