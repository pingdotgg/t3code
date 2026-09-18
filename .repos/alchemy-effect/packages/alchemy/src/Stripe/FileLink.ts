import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetFileLinks,
  GetFileLink,
  CreateFileLink,
  UpdateFileLink,
  type FileLink as StripeFileLink,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export interface FileLinkProps {
  /**
   * Id of the Stripe File this link points at (`file_…`). The file's
   * `purpose` must allow links (for example `dispute_evidence` or
   * `tax_document_user_upload`). Create-only — changing it replaces
   * the file link.
   */
  file: string;
  /**
   * Unix timestamp after which the link is unusable. Omit for a link
   * that never expires. Mutable — pass `undefined` to clear a previously
   * set expiry. Expired links cannot be updated.
   */
  expiresAt?: number;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export type FileLink = Resource<
  "Stripe.FileLink",
  FileLinkProps,
  {
    /** Stripe file link id (`link_…`). */
    id: string;
    /** Id of the File this link points at (`file_…`). */
    file: string;
    /** Public URL to download the file, if the link is still valid. */
    url: string | undefined;
    /** Whether the link has already expired. */
    expired: boolean;
    /** Unix timestamp after which the link is unusable, if set. */
    expiresAt: number | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the file link was created. */
    created: number;
    /** Whether the file link exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe File Link — a public URL for a File that does not require
 * Stripe authentication. `file` is create-only; changing it replaces the
 * link. `expiresAt` and `metadata` update in place. Expired links cannot
 * be updated. Destroy expires the link (`expires_at: "now"`) rather than
 * deleting it — Stripe has no file-link delete API.
 *
 * @see https://docs.stripe.com/api/file_links
 *
 * ### Creating a File Link
 * **Example:** Link a file
 * ```typescript
 * const link = yield* Stripe.FileLink("report", {
 *   file: "file_123",
 * });
 * ```
 *
 * **Example:** Expiring link with metadata
 * ```typescript
 * const link = yield* Stripe.FileLink("report", {
 *   file: "file_123",
 *   expiresAt: 1900000000,
 *   metadata: { kind: "report" },
 * });
 * ```
 *
 * ### Updating a File Link
 * **Example:** Extend expiry and retag
 * ```typescript
 * const link = yield* Stripe.FileLink("report", {
 *   file: "file_123",
 *   expiresAt: 1920000000,
 *   metadata: { kind: "report", env: "prod" },
 * });
 * ```
 *
 * ### Expiring a File Link
 * **Example:** Destroy expires rather than deleting
 * ```typescript
 * const link = yield* Stripe.FileLink("report", {
 *   file: "file_123",
 * });
 * // stack.destroy() sets expires_at to now
 * ```
 *
 * @resource
 */
export const FileLink = Resource<FileLink>("Stripe.FileLink");

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const fileIdOf = (file: StripeFileLink["file"]): string => {
  if (typeof file === "string") return file;
  return file.id;
};

const toAttrs = (link: StripeFileLink) => ({
  id: link.id,
  file: fileIdOf(link.file),
  url: link.url ?? undefined,
  expired: link.expired,
  expiresAt: link.expires_at ?? undefined,
  metadata: userMetadata(link.metadata),
  created: link.created,
  livemode: link.livemode,
});

const isMissingFileLink = isMissingStripeResource;

const getById = (link: string) =>
  GetFileLink({ link }).pipe(
    Effect.catchIf(isMissingFileLink, () => Effect.succeed(undefined)),
  );

const paginateFileLinks = Effect.fn(function* (query: {
  expired?: boolean;
  file?: string;
}) {
  const links: StripeFileLink[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetFileLinks({
      ...(query.expired !== undefined ? { expired: query.expired } : {}),
      ...(query.file !== undefined ? { file: query.file } : {}),
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    links.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return links;
});

const listUnexpired = () => paginateFileLinks({ expired: false });

const findByAlchemyId = Effect.fn(function* (
  id: string,
  links: ReadonlyArray<StripeFileLink>,
) {
  const matches: StripeFileLink[] = [];
  for (const link of links) {
    if (link.expired) continue;
    if (yield* hasAlchemyMetadata(id, tagRecord(link.metadata))) {
      matches.push(link);
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  logicalId: string;
  file?: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined && !byId.expired) return byId;
  }
  if (input.file !== undefined) {
    const byFile = yield* findByAlchemyId(
      input.logicalId,
      yield* paginateFileLinks({ expired: false, file: input.file }),
    );
    if (byFile !== undefined) return byFile;
  }
  return yield* findByAlchemyId(input.logicalId, yield* listUnexpired());
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(metadata),
    ...(yield* createInternalMetadata(id)),
  };
});

export const FileLinkProvider = () =>
  Provider.succeed(FileLink, {
    stables: ["id", "file", "created", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined && news.file !== output.file) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const existing = yield* observe({
        id: output?.id,
        logicalId: id,
        file: olds?.file ?? output?.file,
      });
      if (existing === undefined || existing.expired) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      // Default list API includes expired links; those are already
      // "deleted" (expire-on-destroy) and must not re-enter nuke.
      const links = yield* listUnexpired();
      return links
        .filter((link) => {
          const metadata = tagRecord(link.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredExpiresAt = news.expiresAt;

      let current: StripeFileLink | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
        file: news.file,
      });
      // Expired links cannot be updated, and the File on a link is
      // immutable. Treat either as missing so ensure creates a new link.
      if (current !== undefined && current.expired) {
        current = undefined;
      }
      if (current !== undefined && fileIdOf(current.file) !== news.file) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateFileLink({
          file: news.file,
          metadata,
          ...(desiredExpiresAt !== undefined
            ? { expires_at: desiredExpiresAt }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-file-link-${instanceId}`,
          }),
        );
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const observedExpiresAt = current.expires_at ?? undefined;
      const expiresAtChanged = observedExpiresAt !== desiredExpiresAt;

      if (!metadataChanged && !expiresAtChanged) {
        return toAttrs(current);
      }

      const updated = yield* UpdateFileLink({
        link: current.id,
        ...(expiresAtChanged
          ? {
              expires_at:
                desiredExpiresAt !== undefined ? desiredExpiresAt : "",
            }
          : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(
                  upsert.map((tag) => [tag.Key, tag.Value]),
                ),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || existing.expired) return;
      yield* UpdateFileLink({
        link: existing.id,
        expires_at: "now",
      }).pipe(
        Effect.catchIf(isMissingFileLink, () => Effect.void),
        Effect.catchTag("InvalidRequestError", () => Effect.void),
      );
    }),
  });
