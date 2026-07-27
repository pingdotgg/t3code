import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  syncManagedIntegrationsTags,
  toTagRecord,
  unwrapSensitive,
} from "./internal.ts";

export interface CredentialLockerProps {
  /**
   * Name of the credential locker. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing the name replaces the
   * locker (there is no update API).
   */
  name?: string;
  /**
   * User-defined tags to apply to the credential locker.
   */
  tags?: Record<string, string>;
}

export interface CredentialLocker extends Resource<
  "AWS.IoTManagedIntegrations.CredentialLocker",
  CredentialLockerProps,
  {
    /** Service-generated identifier of the credential locker. */
    credentialLockerId: string;
    /** ARN of the credential locker. */
    credentialLockerArn: string;
    /** Name of the credential locker. */
    credentialLockerName: string;
    /** Tags applied to the credential locker (user + internal). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Managed Integrations credential locker — a secured store for the
 * credentials that devices use to onboard and authenticate with Managed
 * integrations.
 *
 * IoT Managed Integrations is a regional service available in a limited set
 * of regions (e.g. `eu-west-1`, `ca-central-1`).
 *
 * @resource
 * @section Creating Credential Lockers
 * @example Basic Credential Locker
 * ```typescript
 * const locker = yield* CredentialLocker("DeviceCredentials", {});
 * ```
 *
 * @example Named Credential Locker with Tags
 * ```typescript
 * const locker = yield* CredentialLocker("DeviceCredentials", {
 *   name: "my-device-credentials",
 *   tags: { team: "iot" },
 * });
 * ```
 */
export const CredentialLocker = Resource<CredentialLocker>(
  "AWS.IoTManagedIntegrations.CredentialLocker",
);

export const CredentialLockerProvider = () =>
  Provider.effect(
    CredentialLocker,
    Effect.gen(function* () {
      const toName = (id: string, props: CredentialLockerProps = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      // Observe by service-generated Id.
      const observeById = (identifier: string) =>
        mi
          .getCredentialLocker({ Identifier: identifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // Recover an existing locker by name when no Id is cached (e.g. after a
      // state persistence failure). Names are not unique server-side, so take
      // the first match.
      const findByName = Effect.fn(function* (name: string) {
        const summary = yield* mi.listCredentialLockers.items({}).pipe(
          Stream.filter((item) => unwrapSensitive(item.Name) === name),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]),
        );
        if (summary?.Id === undefined) return undefined;
        return yield* observeById(summary.Id);
      });

      const toAttributes = Effect.fn(function* (
        locker: mi.GetCredentialLockerResponse,
      ) {
        const name = unwrapSensitive(locker.Name);
        if (
          locker.Id === undefined ||
          locker.Arn === undefined ||
          name === undefined
        ) {
          return yield* Effect.fail(
            new Error("credential locker response is missing Id, Arn, or Name"),
          );
        }
        return {
          credentialLockerId: locker.Id,
          credentialLockerArn: locker.Arn,
          credentialLockerName: name,
          tags: toTagRecord(locker.Tags),
        };
      });

      return {
        stables: [
          "credentialLockerId",
          "credentialLockerArn",
          "credentialLockerName",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const locker =
            output?.credentialLockerId !== undefined
              ? yield* observeById(output.credentialLockerId)
              : yield* findByName(yield* toName(id, olds ?? {}));
          if (locker === undefined) return undefined;
          const attrs = yield* toAttributes(locker);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — cloud state is authoritative; output is only an Id cache.
          let locker =
            output?.credentialLockerId !== undefined
              ? yield* observeById(output.credentialLockerId)
              : yield* findByName(name);

          // Ensure — create if missing (there is no name-uniqueness conflict
          // to race against; creation is idempotent via ClientToken).
          if (locker === undefined) {
            const created = yield* mi.createCredentialLocker({
              Name: name,
              Tags: desiredTags,
            });
            if (created.Id === undefined) {
              return yield* Effect.fail(
                new Error(`failed to create credential locker '${name}'`),
              );
            }
            locker = yield* observeById(created.Id);
            if (locker === undefined) {
              return yield* Effect.fail(
                new Error(
                  `credential locker '${created.Id}' vanished after create`,
                ),
              );
            }
          }

          // Sync tags — diff against OBSERVED cloud tags.
          if (locker.Arn !== undefined) {
            yield* syncManagedIntegrationsTags(
              locker.Arn,
              toTagRecord(locker.Tags),
              desiredTags,
            );
          }

          const attrs = yield* toAttributes(locker);
          yield* session.note(attrs.credentialLockerArn);
          return { ...attrs, tags: desiredTags };
        }),
        // Enumerate every credential locker in the account/region. Fetch each
        // locker to resolve its tags (summaries omit them).
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* mi.listCredentialLockers.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const lockers = yield* Effect.forEach(
              summaries.filter(
                (s): s is mi.CredentialLockerSummary & { Id: string } =>
                  s.Id !== undefined,
              ),
              (summary) => observeById(summary.Id),
              { concurrency: 5 },
            );
            return yield* Effect.forEach(
              lockers.filter(
                (locker): locker is mi.GetCredentialLockerResponse =>
                  locker !== undefined,
              ),
              toAttributes,
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* mi
            .deleteCredentialLocker({ Identifier: output.credentialLockerId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
