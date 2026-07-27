import * as lexm from "@distilled.cloud/aws/lex-models-v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/** A Lex V2 resource ended in a terminal `Failed` state (or never settled). */
export class LexOperationFailed extends Data.TaggedError("LexOperationFailed")<{
  readonly resourceId: string;
  readonly status: string;
  readonly reasons: readonly string[];
}> {}

/**
 * Coerce a generated physical name into Lex's name pattern
 * `^([0-9a-zA-Z][_-]?){1,100}$` — every `-`/`_` must be preceded by an
 * alphanumeric (no leading or consecutive separators).
 */
export const toLexName = (name: string): string =>
  name
    .replace(/[^0-9a-zA-Z_-]/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 100);

/** Convert a Lex wire tag map (values may be undefined) into a plain record. */
export const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Retry `ConflictException`s on a bounded schedule. Lex serializes most
 * mutations per bot — a concurrent build/version/update surfaces as a
 * transient conflict.
 *
 * The explicit `Effect.Effect<A, E, R>` return annotation is load-bearing:
 * inlining retry/repeat combinators in provider lifecycle code lets their
 * conditional return types survive into declaration emit and widen the
 * provider layer to `unknown` (see `../EC2/VolumeAttachment.ts`).
 */
export const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed(2000), Schedule.recurs(10)]),
  });

/**
 * Repeat a describe poll until `done` holds (bounded). Explicitly typed for
 * the declaration-emit reason above.
 */
const untilConverged = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  done: (a: A) => boolean,
  options?: { intervalSeconds?: number; times?: number },
): Effect.Effect<A, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.spaced(`${options?.intervalSeconds ?? 2} seconds`),
    until: done,
    times: options?.times ?? 40,
  });

const transientBotStatuses = new Set([
  "Creating",
  "Versioning",
  "Updating",
  "Importing",
]);

/**
 * Poll `describeBot` until the bot leaves its transient statuses
 * (`Creating`/`Versioning`/`Updating`/`Importing`). Fails typed on `Failed`.
 * Bot mutations settle in seconds — budget ~80s.
 */
export const waitForBotSettled = Effect.fn("AWS.LexV2.waitForBotSettled")(
  function* (botId: string) {
    const bot = yield* untilConverged(
      lexm.describeBot({ botId }),
      (b) => !transientBotStatuses.has(b.botStatus ?? ""),
    );
    if (
      bot.botStatus === "Failed" ||
      transientBotStatuses.has(bot.botStatus ?? "")
    ) {
      return yield* Effect.fail(
        new LexOperationFailed({
          resourceId: botId,
          status: bot.botStatus ?? "unknown",
          reasons: bot.failureReasons ?? [],
        }),
      );
    }
    return bot;
  },
);

const transientLocaleStatuses = new Set([
  "Creating",
  "Processing",
  "Importing",
  "Deleting",
]);

/**
 * Poll `describeBotLocale` until the DRAFT locale leaves its create-time
 * transient statuses (settles at `NotBuilt`/`Built`/`ReadyExpressTesting`).
 * Fails typed on `Failed`.
 */
export const waitForLocaleSettled = Effect.fn("AWS.LexV2.waitForLocaleSettled")(
  function* (botId: string, localeId: string) {
    const locale = yield* untilConverged(
      lexm.describeBotLocale({ botId, botVersion: "DRAFT", localeId }),
      (l) => !transientLocaleStatuses.has(l.botLocaleStatus ?? ""),
    );
    if (
      locale.botLocaleStatus === "Failed" ||
      transientLocaleStatuses.has(locale.botLocaleStatus ?? "")
    ) {
      return yield* Effect.fail(
        new LexOperationFailed({
          resourceId: `${botId}/${localeId}`,
          status: locale.botLocaleStatus ?? "unknown",
          reasons: locale.failureReasons ?? [],
        }),
      );
    }
    return locale;
  },
);

/**
 * Poll `describeBotLocale` until a triggered build lands on `Built`.
 * `Building` and `ReadyExpressTesting` are intermediate build states. A tiny
 * bot normally builds in under a minute; keep the poll bounded to ~90 seconds
 * so a stalled AWS build fails promptly.
 */
export const waitForLocaleBuilt = Effect.fn("AWS.LexV2.waitForLocaleBuilt")(
  function* (botId: string, localeId: string) {
    const locale = yield* untilConverged(
      lexm.describeBotLocale({ botId, botVersion: "DRAFT", localeId }),
      (l) => l.botLocaleStatus === "Built" || l.botLocaleStatus === "Failed",
      { intervalSeconds: 5, times: 18 },
    );
    if (locale.botLocaleStatus !== "Built") {
      return yield* Effect.fail(
        new LexOperationFailed({
          resourceId: `${botId}/${localeId}`,
          status: locale.botLocaleStatus ?? "unknown",
          reasons: locale.failureReasons ?? [],
        }),
      );
    }
    return locale;
  },
);

/**
 * Poll `describeBotAlias` until the alias leaves `Creating`. Fails typed on
 * `Failed`.
 */
export const waitForAliasSettled = Effect.fn("AWS.LexV2.waitForAliasSettled")(
  function* (botId: string, botAliasId: string) {
    const alias = yield* untilConverged(
      lexm.describeBotAlias({ botId, botAliasId }),
      (a) => a.botAliasStatus !== "Creating",
    );
    if (
      alias.botAliasStatus === "Failed" ||
      alias.botAliasStatus === "Creating"
    ) {
      return yield* Effect.fail(
        new LexOperationFailed({
          resourceId: `${botId}/${botAliasId}`,
          status: alias.botAliasStatus ?? "unknown",
          reasons: [],
        }),
      );
    }
    return alias;
  },
);

/**
 * Read the observed tags of a Lex resource by ARN. Best-effort — a race with
 * deletion reports no tags.
 */
export const readLexTags = Effect.fn("AWS.LexV2.readLexTags")(function* (
  arn: string,
) {
  const response = yield* lexm
    .listTagsForResource({ resourceARN: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on a Lex resource: diff OBSERVED cloud tags against the desired
 * set and apply only the delta.
 */
export const syncLexTags = Effect.fn("AWS.LexV2.syncLexTags")(function* (
  arn: string,
  observed: Record<string, string>,
  desired: Record<string, string>,
) {
  const { removed, upsert } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* lexm.tagResource({
      resourceARN: arn,
      tags: Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
    });
  }
  if (removed.length > 0) {
    yield* lexm.untagResource({ resourceARN: arn, tagKeys: removed });
  }
});
