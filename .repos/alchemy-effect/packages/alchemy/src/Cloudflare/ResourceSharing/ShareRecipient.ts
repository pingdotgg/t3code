import * as resourceSharing from "@distilled.cloud/cloudflare/resource-sharing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.ResourceSharing.ShareRecipient" as const;
type TypeId = typeof TypeId;

/**
 * Association status of a share recipient. Association is eventually
 * consistent — a new recipient transitions `associating → associated`.
 */
export type ShareRecipientAssociationStatus =
  | "associating"
  | "associated"
  | "disassociating"
  | "disassociated";

export type ShareRecipientProps = {
  /**
   * The share the recipient is added to. Changing the share triggers a
   * replacement.
   */
  shareId: string;
  /**
   * Recipient account identifier. Exactly one of `accountId` /
   * `organizationId` must be set. Changing it triggers a replacement.
   */
  accountId?: string;
  /**
   * Recipient organization identifier. Exactly one of `accountId` /
   * `organizationId` must be set. Changing it triggers a replacement.
   */
  organizationId?: string;
};

export type ShareRecipientAttributes = {
  /**
   * Share recipient identifier tag. Stable for the life of the recipient.
   */
  recipientId: string;
  /**
   * The Cloudflare account that owns (sends) the share.
   */
  accountId: string;
  /**
   * The share the recipient belongs to.
   */
  shareId: string;
  /**
   * The recipient account identifier reported by Cloudflare.
   */
  recipientAccountId: string;
  /**
   * Association status of the recipient. Eventually consistent —
   * `associating` settles to `associated`.
   */
  associationStatus: ShareRecipientAssociationStatus;
  /**
   * When the recipient was created.
   */
  created: string;
  /**
   * When the recipient was last modified.
   */
  modified: string;
};

export type ShareRecipient = Resource<
  TypeId,
  ShareRecipientProps,
  ShareRecipientAttributes,
  never,
  Providers
>;

/**
 * A recipient on an existing Cloudflare share — grants another account or
 * organization access to the share's resources.
 *
 * This is an existence-only resource: there is no update API, so every prop
 * change triggers a replacement. Association is eventually consistent
 * (`associating → associated`). Do not manage the same recipient both inline
 * on `Share.recipients` and through this resource.
 * @resource
 * @product Resource Sharing
 * @category Account & Identity
 * @section Adding a Recipient
 * @example Share with another account
 * ```typescript
 * const recipient = yield* Cloudflare.ResourceSharing.ShareRecipient("Partner", {
 *   shareId: share.shareId,
 *   accountId: "<recipient-account-id>",
 * });
 * ```
 *
 * @example Share with an organization
 * ```typescript
 * const recipient = yield* Cloudflare.ResourceSharing.ShareRecipient("Org", {
 *   shareId: share.shareId,
 *   organizationId: "<recipient-organization-id>",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/manage-account-resources/
 */
export const ShareRecipient = Resource<ShareRecipient>(TypeId);

/**
 * Returns true if the given value is a ShareRecipient resource.
 */
export const isShareRecipient = (value: unknown): value is ShareRecipient =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ShareRecipientProvider = () =>
  Provider.succeed(ShareRecipient, {
    stables: [
      "recipientId",
      "accountId",
      "shareId",
      "recipientAccountId",
      "created",
    ],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // No update API — every identity change is a replacement. By diff
      // time both sides are resolved strings.
      const oldShareId = output?.shareId ?? olds?.shareId;
      if (
        typeof oldShareId === "string" &&
        typeof news.shareId === "string" &&
        oldShareId !== news.shareId
      ) {
        return { action: "replace" } as const;
      }
      const oldTarget =
        output?.recipientAccountId ??
        (olds?.accountId as string | undefined) ??
        (olds?.organizationId as string | undefined);
      const newTarget =
        (news.accountId as string | undefined) ??
        (news.organizationId as string | undefined);
      if (
        typeof oldTarget === "string" &&
        typeof newTarget === "string" &&
        oldTarget !== newTarget
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const shareId = output?.shareId ?? (olds?.shareId as string | undefined);
      if (shareId === undefined) return undefined;

      if (output?.recipientId) {
        const observed = yield* getRecipient(acct, shareId, output.recipientId);
        return observed ? toAttributes(observed, acct, shareId) : undefined;
      }
      // Cold read — recover from lost state by matching the recipient
      // account/organization id among the share's recipients.
      const target =
        (olds?.accountId as string | undefined) ??
        (olds?.organizationId as string | undefined);
      if (target === undefined) return undefined;
      const match = yield* findRecipient(acct, shareId, target);
      return match ? toAttributes(match, acct, shareId) : undefined;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const shareId = news.shareId as string;
      const targetAccountId = news.accountId as string | undefined;
      const targetOrganizationId = news.organizationId as string | undefined;

      // Observe — the recipientId cached on `output` is a hint; fall
      // through to a natural-key lookup so an AlreadyExists race converges
      // instead of failing, then to create. Existence-only resource: there
      // is no sync step.
      const observed =
        (output?.recipientId
          ? yield* getRecipient(acct, shareId, output.recipientId)
          : undefined) ??
        (yield* findRecipient(
          acct,
          shareId,
          targetAccountId ?? targetOrganizationId ?? "",
        ));

      if (observed) {
        return toAttributes(observed, acct, shareId);
      }

      // Ensure — greenfield (or out-of-band delete).
      const created = yield* resourceSharing.createRecipient({
        pathAccountId: acct,
        shareId,
        bodyAccountId: targetAccountId,
        organizationId: targetOrganizationId,
      });
      return toAttributes(created, acct, shareId);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Disassociation is eventually consistent; the DELETE call is
      // idempotent against a missing recipient.
      yield* resourceSharing
        .deleteRecipient({
          accountId: output.accountId,
          shareId: output.shareId,
          recipientId: output.recipientId,
        })
        .pipe(Effect.catchTag("ShareRecipientNotFound", () => Effect.void));
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Parent fan-out: recipients are keyed by their parent Share, which is
      // account-scoped. Enumerate the account's owned (sent) shares, then list
      // recipients within each share with bounded concurrency.
      const shareIds = yield* resourceSharing.listResourceSharings
        .pages({ accountId, kind: "sent" })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((share) => share.id),
            ),
          ),
          // The account cannot enumerate shares — nothing to list.
          Effect.catchTag("Forbidden", () => Effect.succeed([] as string[])),
        );

      const rows = yield* Effect.forEach(
        shareIds,
        (shareId) =>
          resourceSharing.listRecipients.pages({ accountId, shareId }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? [])
                  // Disassociated recipients are "gone" — match `read`.
                  .filter((r) => r.associationStatus !== "disassociated")
                  .map((r) => toAttributes(r, accountId, shareId)),
              ),
            ),
            // The share vanished mid-enumeration or isn't ours — skip it.
            Effect.catchTag(["ShareNotFound", "Forbidden"], () =>
              Effect.succeed([] as ShareRecipientAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

type ObservedRecipient = resourceSharing.GetRecipientResponse;

/**
 * Read a recipient by id, mapping "gone" (`ShareRecipientNotFound`, HTTP
 * 404) and the terminal `disassociated` status to `undefined`.
 */
const getRecipient = (
  accountId: string,
  shareId: string,
  recipientId: string,
) =>
  resourceSharing.getRecipient({ accountId, shareId, recipientId }).pipe(
    Effect.map((recipient): ObservedRecipient | undefined =>
      recipient.associationStatus === "disassociated" ? undefined : recipient,
    ),
    Effect.catchTag("ShareRecipientNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a live recipient by its account/organization id. A missing share
 * surfaces as `ShareNotFound` — treat it as "no recipient".
 */
const findRecipient = (accountId: string, shareId: string, target: string) =>
  resourceSharing.listRecipients
    .items({ accountId, shareId, perPage: 50 })
    .pipe(
      Stream.filter(
        (r) =>
          r.accountId === target && r.associationStatus !== "disassociated",
      ),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
      Effect.catchTag("ShareNotFound", () => Effect.succeed(undefined)),
    );

const toAttributes = (
  recipient:
    | ObservedRecipient
    | resourceSharing.CreateRecipientResponse
    | resourceSharing.ListRecipientsResponse["result"][number],
  accountId: string,
  shareId: string,
): ShareRecipientAttributes => ({
  recipientId: recipient.id,
  accountId,
  shareId,
  recipientAccountId: recipient.accountId,
  // Distilled widens generated string enums to open unions (`string & {}`).
  associationStatus:
    recipient.associationStatus as ShareRecipientAssociationStatus,
  created: recipient.created,
  modified: recipient.modified,
});
