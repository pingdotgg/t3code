import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  billingAccountIdOf,
  billingAccountParent,
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  lookupProjectBillingAccountId,
  parseDescription,
  resolveBillingAccountId,
  toPhysicalId,
} from "./internal.ts";

export type BillingExclusionProps = {
  /**
   * Exclusion id (the `{exclusion}` segment of
   * `billingAccounts/{billingAccount}/exclusions/{exclusion}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Limited to 100 characters: letters, digits, underscores, hyphens,
   * periods; first character must be alphanumeric. Immutable — changing
   * it replaces the exclusion.
   */
  exclusionId?: string;
  /**
   * Billing account id (`XXXXXX-XXXXXX-XXXXXX` or
   * `billingAccounts/{id}`). If omitted, Alchemy uses the billing
   * account linked to the current project. Immutable — changing it
   * replaces the exclusion.
   */
  billingAccountId?: string;
  /**
   * Advanced logs filter matching entries to exclude from the `_Default`
   * sink. Required.
   */
  filter: string;
  /**
   * Human-readable description. Logging exclusions have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * When true, the exclusion exists but does not exclude any entries.
   * @default false
   */
  disabled?: boolean;
};

export type BillingExclusion = Resource<
  "GCP.Logging.BillingExclusion",
  BillingExclusionProps,
  {
    /** Full resource name `billingAccounts/{billingAccount}/exclusions/{exclusionId}`. */
    name: string;
    /** Exclusion id (last path segment). */
    exclusionId: string;
    /** Billing account id. */
    billingAccountId: string;
    /** Advanced logs filter. */
    filter: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the exclusion is disabled. */
    disabled: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging exclusion on a billing account `_Default` sink.
 *
 * Exclusions drop matching log entries before they are stored in the
 * `_Default` bucket (they do not apply to `_Required`). Logging exclusions
 * have no labels field, so Alchemy stamps ownership into the description
 * for `list` / nuke. Name is identity — changing `exclusionId` or
 * `billingAccountId` replaces the exclusion.
 *
 * ### Creating a Billing Exclusion
 * **Example:** Generated name, drop debug logs
 * ```typescript
 * const exclusion = yield* GCP.Logging.BillingExclusion("DropDebug", {
 *   filter: "severity=DEBUG",
 *   description: "drop debug entries",
 * });
 * ```
 *
 * **Example:** Named exclusion on an explicit billing account
 * ```typescript
 * const exclusion = yield* GCP.Logging.BillingExclusion("DropDebug", {
 *   billingAccountId: "AAAAAA-BBBBBB-CCCCCC",
 *   exclusionId: "drop-debug",
 *   filter: "severity=DEBUG",
 * });
 * ```
 *
 * ### Updating a Billing Exclusion
 * **Example:** Change the filter and disable
 * ```typescript
 * const exclusion = yield* GCP.Logging.BillingExclusion("DropDebug", {
 *   filter: "severity<ERROR",
 *   description: "drop non-errors",
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const BillingExclusion = Resource<BillingExclusion>(
  "GCP.Logging.BillingExclusion",
);

export class BillingExclusionNotResolved extends Data.TaggedError(
  "GCP.Logging.BillingExclusionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (billingAccountId: string, exclusionId: string) =>
  `${billingAccountParent(billingAccountId)}/exclusions/${exclusionId}`;

const exclusionIdOf = (exclusion: logging.LogExclusion) => {
  const raw = exclusion.name ?? "";
  return raw.includes("/") ? lastSegment(raw) : raw;
};

const billingAccountOfName = (name: string, fallback: string) => {
  const match = name.match(/^billingAccounts\/([^/]+)\//);
  return match?.[1] ?? fallback;
};

const toAttrs = (exclusion: logging.LogExclusion, billingAccountId: string) => {
  const exclusionId = exclusionIdOf(exclusion);
  const parsed = parseDescription(exclusion.description);
  const account = billingAccountOfName(exclusion.name ?? "", billingAccountId);
  return {
    name:
      exclusion.name?.includes("/") === true
        ? exclusion.name
        : resourceName(account, exclusionId),
    exclusionId,
    billingAccountId: account,
    filter: exclusion.filter ?? "",
    description: parsed.description,
    disabled: exclusion.disabled === true,
    createTime: exclusion.createTime,
    updateTime: exclusion.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getBillingAccountsExclusions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const BillingExclusionProvider = () =>
  Provider.succeed(BillingExclusion, {
    stables: ["name", "exclusionId", "billingAccountId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.exclusionId ?? output?.exclusionId;
      const idChanged =
        previousId !== undefined &&
        news.exclusionId !== undefined &&
        news.exclusionId !== previousId;
      const previousAccount =
        olds?.billingAccountId ?? output?.billingAccountId;
      const accountChanged =
        previousAccount !== undefined &&
        news.billingAccountId !== undefined &&
        billingAccountIdOf(news.billingAccountId) !==
          billingAccountIdOf(previousAccount);
      if (!idChanged && !accountChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        olds?.billingAccountId,
        output?.billingAccountId,
      );
      const exclusionId = yield* toPhysicalId(
        id,
        olds?.exclusionId,
        output?.exclusionId,
        "e",
      );
      const name = output?.name ?? resourceName(billingAccountId, exclusionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, billingAccountId);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const billingAccountId = yield* lookupProjectBillingAccountId(
          env.project,
        );
        if (billingAccountId === undefined) return [];
        return yield* logging.listBillingAccountsExclusions
          .pages({
            parent: billingAccountParent(billingAccountId),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.exclusions ?? []),
            ),
            Stream.filter((exclusion) =>
              hasOwnershipMarker(exclusion.description),
            ),
            Stream.map((exclusion) => toAttrs(exclusion, billingAccountId)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as BillingExclusion["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        news.billingAccountId,
        output?.billingAccountId,
      );
      const exclusionId = yield* toPhysicalId(
        id,
        news.exclusionId,
        output?.exclusionId,
        "e",
      );
      const name = resourceName(billingAccountId, exclusionId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createBillingAccountsExclusions({
            parent: billingAccountParent(billingAccountId),
            body: {
              name: exclusionId,
              filter: news.filter,
              description: desiredDescription,
              disabled: news.disabled === true ? true : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BillingExclusionNotResolved({ name });
      }

      const desiredDisabled = news.disabled === true;
      const filterChanged = (current.filter ?? "") !== news.filter;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const disabledChanged = (current.disabled === true) !== desiredDisabled;

      const updateMask = [
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
        disabledChanged ? "disabled" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchBillingAccountsExclusions({
          name: current.name?.includes("/") ? current.name : name,
          updateMask: updateMask.join(","),
          body: {
            filter: news.filter,
            description: desiredDescription,
            disabled: desiredDisabled,
          },
        });
      }

      return toAttrs(current, billingAccountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteBillingAccountsExclusions({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
