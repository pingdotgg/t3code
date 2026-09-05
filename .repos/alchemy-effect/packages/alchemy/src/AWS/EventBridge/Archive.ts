import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toWireDays } from "../../Util/Duration.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type { ArchiveState } from "@distilled.cloud/aws/eventbridge";

export type ArchiveName = string;
export type ArchiveArn =
  `arn:aws:events:${RegionID}:${AccountID}:archive/${ArchiveName}`;

export interface ArchiveProps {
  /**
   * Name of the archive. Must match [\.\-_A-Za-z0-9]+, 1-48 characters.
   * If omitted, a unique name will be generated.
   */
  name?: ArchiveName;

  /**
   * ARN of the event bus whose events are archived. Immutable — changing it
   * replaces the archive.
   */
  eventSourceArn: string;

  /**
   * Description of the archive. Max 512 characters.
   */
  description?: string;

  /**
   * Event pattern filtering which events are archived, as a JSON-compatible
   * object. If omitted, all events on the source bus are archived (except
   * replayed events).
   */
  eventPattern?: Record<string, any>;

  /**
   * How long events are retained in the archive, as any `Duration.Input`
   * (e.g. `"30 days"`, `Duration.days(90)`); converted to whole days on the
   * wire (`RetentionDays`).
   * @default indefinite retention
   */
  retention?: Duration.Input;

  /**
   * The identifier of the KMS customer managed key to encrypt events in this
   * archive. Strongly recommended when the source event bus uses a customer
   * managed key.
   */
  kmsKeyIdentifier?: string;
}

/**
 * An Amazon EventBridge archive that retains events from an event bus so
 * they can later be replayed (see the replay bindings: `StartReplay`,
 * `DescribeReplay`, `CancelReplay`, `ListReplays`).
 *
 * Archives do not support tags, so ownership is tracked by the
 * deterministic physical name.
 * @resource
 * @section Archiving Events
 * @example Archive All Events on a Bus
 * ```typescript
 * const bus = yield* AWS.EventBridge.EventBus("AppEvents", {});
 *
 * const archive = yield* AWS.EventBridge.Archive("AppArchive", {
 *   eventSourceArn: bus.eventBusArn,
 *   retention: "30 days",
 * });
 * ```
 *
 * @example Archive a Filtered Subset of Events
 * ```typescript
 * const archive = yield* AWS.EventBridge.Archive("OrderArchive", {
 *   eventSourceArn: bus.eventBusArn,
 *   description: "Order events only",
 *   eventPattern: { source: ["my.app"], "detail-type": ["OrderCreated"] },
 *   retention: "90 days",
 * });
 * ```
 */
export interface Archive extends Resource<
  "AWS.EventBridge.Archive",
  ArchiveProps,
  {
    /** The name of the archive. */
    archiveName: ArchiveName;
    /** The ARN of the archive. */
    archiveArn: ArchiveArn;
    /** The ARN of the event bus the archive sources events from. */
    eventSourceArn: string;
  },
  never,
  Providers
> {}
export const Archive = Resource<Archive>("AWS.EventBridge.Archive");

export const ArchiveProvider = () =>
  Provider.effect(
    Archive,
    Effect.gen(function* () {
      const createArchiveName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({
              id,
              maxLength: 48,
            });

      /**
       * Poll until the archive leaves its transitional state. Archive
       * creation/updates settle in seconds; the wait is bounded so a stuck
       * archive surfaces the last observed state instead of hanging.
       */
      const awaitSettled = (archiveName: string) =>
        eventbridge.describeArchive({ ArchiveName: archiveName }).pipe(
          // A describe fired immediately after create can be eventually
          // consistent — absorb NotFound briefly before polling the state.
          Effect.retry({
            while: (e): boolean => e._tag === "ResourceNotFoundException",
            schedule: Schedule.spaced("1 second"),
            times: 5,
          }),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (r): boolean =>
              r.State !== "CREATING" && r.State !== "UPDATING",
            times: 10,
          }),
        );

      return {
        stables: ["archiveName", "archiveArn", "eventSourceArn"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createArchiveName(id, olds);
          const newName = yield* createArchiveName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (olds.eventSourceArn !== news.eventSourceArn) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          // Archives don't support tags; the deterministic physical name is
          // the ownership signal (it embeds app/stage/logical id).
          const archiveName =
            output?.archiveName ?? (yield* createArchiveName(id, olds ?? {}));
          const described = yield* eventbridge
            .describeArchive({ ArchiveName: archiveName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!described?.ArchiveName || !described.ArchiveArn) {
            return undefined;
          }
          return {
            archiveName: described.ArchiveName,
            archiveArn: described.ArchiveArn as ArchiveArn,
            eventSourceArn: described.EventSourceArn ?? "",
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const attrs: {
              archiveName: ArchiveName;
              archiveArn: ArchiveArn;
              eventSourceArn: string;
            }[] = [];
            let nextToken: string | undefined;
            do {
              const page = yield* eventbridge.listArchives({
                NextToken: nextToken,
              });
              for (const archive of page.Archives ?? []) {
                if (!archive.ArchiveName) {
                  continue;
                }
                attrs.push({
                  archiveName: archive.ArchiveName,
                  archiveArn:
                    `arn:aws:events:${region}:${accountId}:archive/${archive.ArchiveName}` as ArchiveArn,
                  eventSourceArn: archive.EventSourceArn ?? "",
                });
              }
              nextToken = page.NextToken;
            } while (nextToken);
            return attrs;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const archiveName =
            output?.archiveName ?? (yield* createArchiveName(id, news));
          const eventPattern = news.eventPattern
            ? JSON.stringify(news.eventPattern)
            : undefined;
          const retentionDays = toWireDays(news.retention);

          // Observe — live cloud state is authoritative; a vanished archive
          // falls through to create.
          const observed = yield* eventbridge
            .describeArchive({ ArchiveName: archiveName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!observed?.ArchiveArn) {
            // Ensure — create the archive; tolerate an AlreadyExists race
            // with a peer reconciler and converge via the update below.
            yield* eventbridge
              .createArchive({
                ArchiveName: archiveName,
                EventSourceArn: news.eventSourceArn,
                Description: news.description,
                EventPattern: eventPattern,
                RetentionDays: retentionDays,
                KmsKeyIdentifier: news.kmsKeyIdentifier,
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
          } else {
            // Sync — updateArchive overwrites description, pattern,
            // retention, and KMS key in one shot (idempotent on matching
            // values).
            yield* eventbridge.updateArchive({
              ArchiveName: archiveName,
              Description: news.description,
              EventPattern: eventPattern,
              RetentionDays: retentionDays,
              KmsKeyIdentifier: news.kmsKeyIdentifier,
            });
          }

          const settled = yield* awaitSettled(archiveName);
          const archiveArn = (settled.ArchiveArn ??
            observed?.ArchiveArn) as ArchiveArn;

          yield* session.note(archiveArn);
          return {
            archiveName,
            archiveArn,
            eventSourceArn: settled.EventSourceArn ?? news.eventSourceArn,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* eventbridge
            .deleteArchive({ ArchiveName: output.archiveName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
