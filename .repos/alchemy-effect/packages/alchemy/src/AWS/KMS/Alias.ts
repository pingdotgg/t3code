import * as kms from "@distilled.cloud/aws/kms";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import type { KeyArn, KeyId } from "./Key.ts";

export type AliasName = `alias/${string}`;
export type AliasArn = `arn:aws:kms:${RegionID}:${AccountID}:${AliasName}`;

export interface AliasProps {
  /**
   * Alias name. Must begin with `alias/`. If omitted, Alchemy generates one.
   */
  aliasName?: AliasName;
  /**
   * Target KMS key ID or ARN for this alias.
   */
  targetKeyId: KeyId | KeyArn;
}

export interface Alias extends Resource<
  "AWS.KMS.Alias",
  AliasProps,
  {
    aliasName: AliasName;
    aliasArn: AliasArn;
    targetKeyId: KeyId;
  },
  never,
  Providers
> {}

/**
 * An AWS KMS alias that points to a customer managed key.
 *
 * @section Creating Aliases
 * @example Alias for a Key
 * ```typescript
 * import * as KMS from "alchemy/AWS/KMS";
 *
 * const key = yield* KMS.Key("AppKey");
 * const alias = yield* KMS.Alias("AppAlias", {
 *   aliasName: "alias/app",
 *   targetKeyId: key.keyId,
 * });
 * ```
 */
export const Alias = Resource<Alias>("AWS.KMS.Alias");

export const AliasProvider = () =>
  Provider.succeed(Alias, {
    stables: ["aliasName", "aliasArn"],
    list: () =>
      Effect.gen(function* () {
        const aliases = yield* kms.listAliases.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.Aliases ?? []),
          ),
        );

        return aliases
          .filter(
            (
              alias,
            ): alias is kms.AliasListEntry & {
              AliasName: AliasName;
              AliasArn: AliasArn;
              TargetKeyId: KeyId;
            } =>
              isCustomerAlias(alias.AliasName) &&
              alias.AliasArn !== undefined &&
              alias.TargetKeyId !== undefined,
          )
          .map((alias) => ({
            aliasName: alias.AliasName,
            aliasArn: alias.AliasArn,
            targetKeyId: alias.TargetKeyId,
          }));
      }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const aliasName =
        output?.aliasName ?? (yield* toAliasName(id, olds ?? {}));
      const state = yield* readAlias(aliasName);
      if (!state) return undefined;
      return output ? state : Unowned(state);
    }),
    diff: Effect.fn(function* ({ id, news, olds = {} }) {
      if (!isResolved(news)) return;
      if ((yield* toAliasName(id, news)) !== (yield* toAliasName(id, olds))) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const aliasName = output?.aliasName ?? (yield* toAliasName(id, news));
      const targetKeyId = yield* resolveTargetKeyId(news.targetKeyId);
      let state = yield* readAlias(aliasName);

      if (!state) {
        yield* kms
          .createAlias({
            AliasName: aliasName,
            TargetKeyId: targetKeyId,
          })
          .pipe(
            Effect.retry({
              while: isKmsEventuallyConsistent,
              schedule: kmsRetrySchedule,
            }),
            Effect.catchTag("AlreadyExistsException", () => Effect.void),
          );
        state = yield* readAlias(aliasName);
      }

      if (state?.targetKeyId !== targetKeyId) {
        yield* kms
          .updateAlias({
            AliasName: aliasName,
            TargetKeyId: targetKeyId,
          })
          .pipe(
            Effect.retry({
              while: isKmsEventuallyConsistent,
              schedule: kmsRetrySchedule,
            }),
          );
        state = yield* readAlias(aliasName);
      }

      if (!state) {
        return yield* Effect.die(
          new Error(`failed to read KMS alias ${aliasName}`),
        );
      }

      yield* session.note(`KMS alias ${aliasName}`);
      return state;
    }),
    delete: Effect.fn(function* ({ output, session }) {
      yield* kms
        .deleteAlias({
          AliasName: output.aliasName,
        })
        .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

      const remaining = yield* Effect.repeat(readAlias(output.aliasName), {
        schedule: Schedule.fixed("250 millis"),
        until: (alias) => alias === undefined,
        times: 20,
      });
      if (remaining !== undefined) {
        yield* Effect.die(
          new Error(
            `KMS alias ${output.aliasName} remained observable after delete`,
          ),
        );
      }
      yield* session.note(`Deleted KMS alias ${output.aliasName}`);
    }),
  });

const toAliasName = Effect.fn(function* (
  id: string,
  props: { aliasName?: AliasName },
) {
  if (props.aliasName) {
    return props.aliasName;
  }

  return `alias/${yield* createPhysicalName({
    id,
    maxLength: 256 - "alias/".length,
  })}` as AliasName;
});

const readAlias = Effect.fn(function* (aliasName: AliasName) {
  const alias = yield* findAlias(aliasName);
  if (!alias?.AliasName || !alias.TargetKeyId) return undefined;

  return {
    aliasName: alias.AliasName as AliasName,
    aliasArn: (alias.AliasArn ?? (yield* aliasArn(aliasName))) as AliasArn,
    targetKeyId: alias.TargetKeyId,
  };
});

const findAlias = Effect.fn(function* (aliasName: AliasName) {
  const aliases = yield* kms.listAliases.pages({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) => page.Aliases ?? []),
    ),
  );

  return aliases.find((alias) => alias.AliasName === aliasName);
});

const aliasArn = Effect.fn(function* (aliasName: AliasName) {
  const { accountId, region } = yield* AWSEnvironment.current;
  return `arn:aws:kms:${region}:${accountId}:${aliasName}` as AliasArn;
});

const resolveTargetKeyId = Effect.fn(function* (targetKeyId: string) {
  const described = yield* kms.describeKey({ KeyId: targetKeyId });
  return described.KeyMetadata?.KeyId!;
});

const isCustomerAlias = (
  aliasName: string | undefined,
): aliasName is AliasName =>
  aliasName !== undefined &&
  aliasName.startsWith("alias/") &&
  !aliasName.startsWith("alias/aws/");

const isKmsEventuallyConsistent = (error: { _tag: string }) =>
  error._tag === "DependencyTimeoutException" ||
  error._tag === "KMSInternalException" ||
  error._tag === "KMSInvalidStateException" ||
  error._tag === "NotFoundException";

const kmsRetrySchedule = Schedule.max([
  Schedule.exponential(250),
  Schedule.recurs(7),
]);
