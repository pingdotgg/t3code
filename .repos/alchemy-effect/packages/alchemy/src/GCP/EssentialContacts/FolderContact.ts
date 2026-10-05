import * as essentialcontacts from "@distilled.cloud/gcp/essentialcontacts_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  desiredCategories,
  desiredLanguage,
  encodeEmail,
  findOwnedContact,
  folderParent,
  hasOwnershipMarker,
  lastSegment,
  listContacts,
  listFolderParents,
  normalizeEmail,
  ownedByAlchemy,
  ownershipLabels,
  resolveFolder,
  sameCategories,
  sameText,
  toCoreAttrs,
  toCreateBody,
  toEmail,
  UPDATE_MASK,
  type NotificationCategory,
} from "./internal.ts";

export type FolderContactProps = {
  /**
   * Parent folder (`folders/{folder}` or the numeric id). Defaults to
   * the project's Resource Manager folder
   * ancestor. Immutable — changing it replaces the contact.
   */
  folderId?: string;
  /**
   * Email address that receives Google Cloud notifications. Does not
   * need to be a Google Account. Immutable — changing it replaces the
   * contact. If omitted, a unique `example.com` address is generated.
   * Essential Contacts have no labels field, so Alchemy stamps
   * ownership into a `+alc.{stack}.{stage}.{id}` plus-tag and strips it
   * from attributes.
   */
  email?: string;
  /**
   * Preferred notification language as a BCP-47 / ISO 639-1 tag
   * (`en-US`, `en-GB`, `ja`, …).
   * @default "en-US"
   */
  languageTag?: string;
  /**
   * Notification categories this contact subscribes to.
   * @default ["ALL"]
   */
  notificationCategorySubscriptions?: NotificationCategory[];
};

export type FolderContact = Resource<
  "GCP.EssentialContacts.FolderContact",
  FolderContactProps,
  {
    /** Full resource name `folders/{folder}/contacts/{contact}`. */
    name: string;
    /** Server-assigned contact id (last path segment). */
    contactId: string;
    /** Parent resource `folders/{folder}`. */
    parent: string;
    /** Folder id (last path segment of `parent`). */
    folderId: string;
    /** Project id used when the contact was reconciled. */
    project: string;
    /** User email with the Alchemy plus-tag stripped. */
    email: string;
    /** Preferred notification language. */
    languageTag: string;
    /** Subscribed notification categories. */
    notificationCategorySubscriptions: NotificationCategory[];
    /** Server-reported validation state. */
    validationState: string | undefined;
    /** RFC3339 time the validation state was last updated. */
    validateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A folder-level Google Cloud Essential Contact.
 *
 * Essential Contacts have no labels field, so Alchemy stamps ownership
 * into the email plus-tag for `list` / nuke. Folder and email are
 * identity — changing either replaces the contact. Language and
 * notification categories update in place.
 *
 * ### Creating a Folder Contact
 * **Example:** Technical contact on a folder
 * ```typescript
 * const contact = yield* GCP.EssentialContacts.FolderContact("Ops", {
 *   folderId: "folders/123",
 *   email: "ops@example.com",
 *   languageTag: "en-US",
 *   notificationCategorySubscriptions: ["TECHNICAL"],
 * });
 * ```
 *
 * **Example:** Subscribe to every category
 * ```typescript
 * const contact = yield* GCP.EssentialContacts.FolderContact("Ops", {
 *   folderId: "123",
 *   email: "ops@example.com",
 *   notificationCategorySubscriptions: ["ALL"],
 * });
 * ```
 *
 * ### Updating a Folder Contact
 * **Example:** Change language and categories
 * ```typescript
 * const contact = yield* GCP.EssentialContacts.FolderContact("Ops", {
 *   folderId: "folders/123",
 *   email: "ops@example.com",
 *   languageTag: "en-GB",
 *   notificationCategorySubscriptions: ["SECURITY", "TECHNICAL"],
 * });
 * ```
 *
 * @resource
 * @category EssentialContacts
 */
export const FolderContact = Resource<FolderContact>(
  "GCP.EssentialContacts.FolderContact",
);

export class FolderContactNotResolved extends Data.TaggedError(
  "GCP.EssentialContacts.FolderContactNotResolved",
)<{
  name: string;
}> {}

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : essentialcontacts
        .getFoldersContacts({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([])
    : listContacts(
        essentialcontacts.listFoldersContacts.pages({
          parent,
          pageSize: 200,
        }),
      );

const toAttrs = (
  contact: essentialcontacts.GoogleCloudEssentialcontactsV1Contact,
  parent: string,
  project: string,
) => {
  const core = toCoreAttrs(contact, parent, project);
  return {
    ...core,
    folderId: lastSegment(core.parent),
  };
};

export const FolderContactProvider = () =>
  Provider.succeed(FolderContact, {
    stables: ["name", "contactId", "parent", "folderId", "project", "email"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEmail = olds?.email ?? output?.email;
      if (
        news.email !== undefined &&
        previousEmail !== undefined &&
        normalizeEmail(news.email) !== normalizeEmail(previousEmail)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousFolder = olds?.folderId ?? output?.folderId;
      if (
        news.folderId !== undefined &&
        previousFolder !== undefined &&
        folderParent(news.folderId) !== folderParent(previousFolder)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = yield* resolveFolder(
        olds?.folderId ?? output?.folderId,
        output?.parent,
      );
      let existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) {
        existing = yield* findOwnedContact(
          yield* listAt(parent),
          id,
          output?.name,
          olds?.email ?? output?.email,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, parent, env.project);
      return (yield* ownedByAlchemy(id, existing.email))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parents = yield* listFolderParents();
        const pages = yield* Effect.forEach(parents, listAt, {
          concurrency: 4,
        });
        return pages.flatMap((contacts, index) =>
          contacts
            .filter((contact) => hasOwnershipMarker(contact.email))
            .map((contact) =>
              toAttrs(contact, parents[index] ?? "", env.project),
            ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = yield* resolveFolder(
        news.folderId ?? output?.folderId,
        output?.parent,
      );
      const ownership = yield* ownershipLabels(id);
      const userEmail = yield* toEmail(id, news.email, output?.email);
      const stampedEmail = encodeEmail(ownership, userEmail);
      const languageTag = desiredLanguage(news.languageTag);
      const categories = desiredCategories(
        news.notificationCategorySubscriptions,
      );
      const body = toCreateBody({
        email: stampedEmail,
        languageTag,
        notificationCategorySubscriptions: categories,
      });

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findOwnedContact(
          yield* listAt(parent),
          id,
          output?.name,
          userEmail,
        );
      }

      if (current === undefined) {
        const created = yield* essentialcontacts
          .createFoldersContacts({ parent, body })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listAt(parent).pipe(
                Effect.flatMap((contacts) =>
                  findOwnedContact(contacts, id, undefined, userEmail),
                ),
              ),
            ),
          );
        current = created ?? undefined;
        if (current?.name) {
          current = (yield* getByName(current.name)) ?? current;
        }
      }

      if (current === undefined) {
        return yield* new FolderContactNotResolved({
          name: output?.name ?? `${parent}/contacts`,
        });
      }

      const languageChanged = !sameText(current.languageTag, languageTag);
      const categoriesChanged = !sameCategories(
        current.notificationCategorySubscriptions,
        categories,
      );
      if (languageChanged || categoriesChanged) {
        current = yield* essentialcontacts.patchFoldersContacts({
          name: current.name ?? "",
          updateMask: UPDATE_MASK,
          body: {
            languageTag,
            notificationCategorySubscriptions: categories,
          },
        });
      }

      return toAttrs(current, parent, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* essentialcontacts
        .deleteFoldersContacts({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
