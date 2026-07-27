import * as paymentcryptography from "@distilled.cloud/aws/payment-cryptography";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface AliasProps {
  /**
   * The alias name. Must begin with `alias/` and may contain alphanumeric
   * characters, forward slashes, underscores and hyphens. Changing it
   * replaces the alias.
   * @default alias/${app}-${stage}-${id}
   */
  aliasName?: string;
  /**
   * The ARN of the key the alias points to. Omit to create an unattached
   * alias; set later to point it at a key. Updated in place.
   */
  keyArn?: string;
}

export interface Alias extends Resource<
  "AWS.PaymentCryptography.Alias",
  AliasProps,
  {
    /**
     * Name of the alias (starts with `alias/`).
     */
    aliasName: string;
    /**
     * ARN of the key the alias points to, if attached.
     */
    keyArn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A friendly name for an AWS Payment Cryptography {@link Key}. Aliases give
 * keys a stable, human-readable identifier that survives key rotation — the
 * alias can be repointed to a new key without touching consumers.
 * @resource
 * @section Creating Aliases
 * @example Alias attached to a key
 * ```typescript
 * import * as PaymentCryptography from "alchemy/AWS/PaymentCryptography";
 *
 * const key = yield* PaymentCryptography.Key("DataKey", { keyAttributes: { ... } });
 * const alias = yield* PaymentCryptography.Alias("DataKeyAlias", {
 *   keyArn: key.keyArn,
 * });
 * ```
 *
 * @example Alias with an explicit name
 * ```typescript
 * const alias = yield* PaymentCryptography.Alias("DataKeyAlias", {
 *   aliasName: "alias/payments/data-encryption",
 *   keyArn: key.keyArn,
 * });
 * ```
 */
export const Alias = Resource<Alias>("AWS.PaymentCryptography.Alias");

const toAttrs = (alias: paymentcryptography.Alias): Alias["Attributes"] => ({
  aliasName: alias.AliasName,
  keyArn: alias.KeyArn,
});

export const AliasProvider = () =>
  Provider.effect(
    Alias,
    Effect.gen(function* () {
      const createAliasName = Effect.fn(function* (
        id: string,
        props: AliasProps,
      ) {
        if (props.aliasName) {
          return props.aliasName;
        }
        const baseName = yield* createPhysicalName({
          id,
          maxLength: 256 - "alias/".length,
        });
        return `alias/${baseName}`;
      });

      const observeAlias = Effect.fn(function* (aliasName: string) {
        return yield* paymentcryptography
          .getAlias({ AliasName: aliasName })
          .pipe(
            Effect.map((r) => r.Alias),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Alias.Provider.of({
        stables: ["aliasName"],
        list: () =>
          paymentcryptography.listAliases.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk).map(toAttrs)),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const aliasName =
            output?.aliasName ?? (yield* createAliasName(id, olds ?? {}));
          const alias = yield* observeAlias(aliasName);
          if (alias === undefined) return undefined;
          return toAttrs(alias);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createAliasName(id, olds);
          const newName = yield* createAliasName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through: undefined → default update (keyArn repoint)
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const aliasName =
            output?.aliasName ?? (yield* createAliasName(id, news));

          // 1. Observe — cloud state is authoritative.
          let alias = yield* observeAlias(aliasName);

          // 2. Ensure — create when missing; a concurrent create surfaces as
          //    ConflictException, which resolves by re-observing.
          if (alias === undefined) {
            alias = yield* paymentcryptography
              .createAlias({ AliasName: aliasName, KeyArn: news.keyArn })
              .pipe(
                Effect.map((r) => r.Alias),
                Effect.catchTag("ConflictException", () =>
                  paymentcryptography
                    .getAlias({ AliasName: aliasName })
                    .pipe(Effect.map((r) => r.Alias)),
                ),
              );
          }

          // 3. Sync — repoint the alias when the observed target differs
          //    from the desired one (including detaching).
          if (alias.KeyArn !== news.keyArn) {
            alias = yield* paymentcryptography
              .updateAlias({ AliasName: aliasName, KeyArn: news.keyArn })
              .pipe(Effect.map((r) => r.Alias));
          }

          yield* session.note(aliasName);
          return toAttrs(alias);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* paymentcryptography
            .deleteAlias({ AliasName: output.aliasName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
