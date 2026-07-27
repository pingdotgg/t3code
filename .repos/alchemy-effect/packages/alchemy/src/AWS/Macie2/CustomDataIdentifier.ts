import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { retryThroughEnablement } from "./common.ts";

export interface CustomDataIdentifierProps {
  /**
   * Custom name for the identifier (1-128 characters). Must be unique per
   * account. If omitted, a unique name is generated from the app/stage/logical
   * ID. Changing this replaces the identifier — custom data identifiers are
   * immutable once created.
   */
  name?: string;

  /**
   * Custom description of the identifier (up to 512 characters). Changing this
   * replaces the identifier.
   */
  description?: string;

  /**
   * The regular expression that defines the text pattern to match (up to 512
   * characters). Changing this replaces the identifier.
   */
  regex: string;

  /**
   * Words that must be in proximity of a pattern match for Macie to report it
   * (up to 50 keywords, each 3-90 UTF-8 characters). Changing this replaces
   * the identifier.
   */
  keywords?: string[];

  /**
   * Words to exclude from the results — a match containing one of these is
   * ignored (up to 10 entries, each 4-90 UTF-8 characters). Changing this
   * replaces the identifier.
   */
  ignoreWords?: string[];

  /**
   * The maximum number of characters between the end of a keyword and the end
   * of the matched text (1-300). Changing this replaces the identifier.
   * @default 50
   */
  maximumMatchDistance?: number;

  /**
   * Severity to assign findings based on the number of occurrences of matched
   * text. Changing this replaces the identifier.
   */
  severityLevels?: macie2.SeverityLevel[];

  /**
   * Tags applied to the identifier. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface CustomDataIdentifier extends Resource<
  "AWS.Macie2.CustomDataIdentifier",
  CustomDataIdentifierProps,
  {
    /** Generated custom data identifier ID. */
    id: string;
    /** ARN of the custom data identifier. */
    arn: string;
    /** The resolved identifier name. */
    name: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Macie custom data identifier — a regex-based detection criterion
 * (with optional keywords, ignore words, and severity thresholds) that
 * classification jobs and automated discovery use to detect organization-
 * specific sensitive data. Requires Macie to be enabled for the account (see
 * `Macie2.Session`). Definitions are immutable: any change other than tags
 * replaces the identifier. Destroy soft-deletes it.
 *
 * @section Creating a custom data identifier
 * @example Employee-id detector
 * ```typescript
 * const identifier = yield* Macie2.CustomDataIdentifier("EmployeeId", {
 *   regex: "EMP-[0-9]{8}",
 *   description: "Internal employee id format",
 * });
 * ```
 *
 * @example Keyword-scoped detector with severity thresholds
 * ```typescript
 * const identifier = yield* Macie2.CustomDataIdentifier("AccountNumber", {
 *   regex: "[0-9]{12}",
 *   keywords: ["account number", "acct no"],
 *   maximumMatchDistance: 30,
 *   severityLevels: [
 *     { occurrencesThreshold: 1, severity: "LOW" },
 *     { occurrencesThreshold: 25, severity: "HIGH" },
 *   ],
 * });
 * ```
 */
const CustomDataIdentifierResource = Resource<CustomDataIdentifier>(
  "AWS.Macie2.CustomDataIdentifier",
);

export { CustomDataIdentifierResource as CustomDataIdentifier };

const createName = (id: string, props: Partial<CustomDataIdentifierProps>) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 128 });

// The whole definition is immutable — any change replaces.
const fingerprint = (props: Partial<CustomDataIdentifierProps>) =>
  JSON.stringify({
    description: props.description,
    regex: props.regex,
    keywords: props.keywords ?? [],
    ignoreWords: props.ignoreWords ?? [],
    maximumMatchDistance: props.maximumMatchDistance,
    severityLevels: props.severityLevels ?? [],
  });

const buildIdentifierAttrs = (
  id: string,
  live: macie2.GetCustomDataIdentifierResponse,
) => ({
  id,
  arn: live.arn!,
  name: live.name!,
});

export const CustomDataIdentifierProvider = () =>
  Provider.effect(
    CustomDataIdentifierResource,
    Effect.gen(function* () {
      const getIdentifier = (id: string) =>
        macie2.getCustomDataIdentifier({ id }).pipe(
          // Deleting is a soft delete — a deleted identifier still answers,
          // flagged `deleted: true`. Treat it (and a disabled Macie session)
          // as gone.
          Effect.map((d) => (d.deleted ? undefined : d)),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
          Effect.catchTag("AccessDeniedException", () =>
            Effect.succeed(undefined),
          ),
        );

      return {
        stables: ["id", "arn", "name"],

        read: Effect.fn(function* ({ id, output }) {
          if (!output?.id) return undefined;
          const live = yield* getIdentifier(output.id);
          if (!live) return undefined;
          const attrs = buildIdentifierAttrs(output.id, live);
          return (yield* hasAlchemyTags(id, live.tags))
            ? attrs
            : Unowned(attrs);
        }),

        list: () =>
          Effect.gen(function* () {
            const pages = yield* macie2.listCustomDataIdentifiers
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.catchTag("AccessDeniedException", () =>
                  Effect.succeed([]),
                ),
              );
            const out: CustomDataIdentifier["Attributes"][] = [];
            for (const page of pages) {
              for (const summary of page.items ?? []) {
                const live = yield* getIdentifier(summary.id!);
                if (live) out.push(buildIdentifierAttrs(summary.id!, live));
              }
            }
            return out;
          }),

        diff: Effect.fn(function* ({ id, news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if (fingerprint(olds) !== fingerprint(news)) {
            return { action: "replace" } as const;
          }
          // The definition is immutable; only tags mutate in place.
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const name = output?.name ?? (yield* createName(id, news));

          // 1. OBSERVE — cloud state is authoritative; output caches the id.
          let identifierId = output?.id;
          let live = identifierId
            ? yield* getIdentifier(identifierId)
            : undefined;

          if (!live || identifierId === undefined) {
            // 2. ENSURE — create the identifier (retry through enablement lag).
            const created = yield* retryThroughEnablement(
              macie2.createCustomDataIdentifier({
                name,
                description: news.description,
                regex: news.regex,
                keywords: news.keywords,
                ignoreWords: news.ignoreWords,
                maximumMatchDistance: news.maximumMatchDistance,
                severityLevels: news.severityLevels,
                tags: desiredTags,
              }),
            );
            identifierId = created.customDataIdentifierId!;
          } else {
            // 3. SYNC tags — the definition is immutable; only tags mutate.
            const { upsert, removed } = diffTags(
              tagRecord(live.tags),
              desiredTags,
            );
            if (upsert.length > 0) {
              yield* macie2.tagResource({
                resourceArn: live.arn!,
                tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              });
            }
            if (removed.length > 0) {
              yield* macie2.untagResource({
                resourceArn: live.arn!,
                tagKeys: removed,
              });
            }
          }

          // 4. RETURN fresh attributes.
          const final = yield* macie2.getCustomDataIdentifier({
            id: identifierId,
          });
          yield* session.note(identifierId);
          return buildIdentifierAttrs(identifierId, final);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent soft delete — the identifier may already be gone, or
          // Macie may already be disabled for the account.
          yield* macie2.deleteCustomDataIdentifier({ id: output.id }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.catchTag("AccessDeniedException", () => Effect.void),
          );
        }),
      };
    }),
  );
